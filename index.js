console.log("--- [MEI-BOT V6] DEMARRAGE FORCE ---");
const ws = require("ws");
global.WebSocket = ws;

const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  realtime: { WebSocket: ws },
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const DUPLICATE_BONUS = { commun: 20, rare: 40, "épique": 70, "légendaire": 150 };
const RARITY_WEIGHTS = { commun: 60, rare: 28, "épique": 10, "légendaire": 2 };
const RARITY_EMOJI = { commun: "⚪", rare: "🔵", "épique": "🟣", "légendaire": "🌟" };

let lastKnownProfileCreatedAt = null;
let lastKnownInventoryTimestamp = null;

// -------------------- Statut JST --------------------
function updateJSTStatus() {
  const now = new Date();
  const jstTime = new Intl.DateTimeFormat("fr-FR", { timeZone: config.TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(now);
  client.user.setActivity(`🕐 ${jstTime} JST à Tokyo`, { type: 4 });
}

// -------------------- Régénération des coins --------------------
function computeRegen(coins, lastRegenISO) {
  const lastRegen = new Date(lastRegenISO);
  const now = new Date();
  const hoursElapsed = (now - lastRegen) / (1000 * 60 * 60);
  const regenAmount = Math.floor(hoursElapsed * 100);
  return { newCoins: Math.min(100, coins + regenAmount) };
}

function pickRarity() {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (const [rarity, weight] of Object.entries(RARITY_WEIGHTS)) {
    if (roll < weight) return rarity;
    roll -= weight;
  }
  return "commun";
}

// -------------------- Lookup profil via email (Auth Admin API) --------------------
async function getProfileByEmail(email) {
  let page = 1;
  const perPage = 200;
  while (page <= 10) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users?.length) break;
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) {
      const { data: profile } = await supabase.from("profiles").select("id, pseudo").eq("id", match.id).single();
      return profile;
    }
    if (data.users.length < perPage) break;
    page++;
  }
  return null;
}

// -------------------- Annonces --------------------
async function announceLegendary(username, itemName, imageUrl) {
  const channel = await client.channels.fetch(config.ANNOUNCE_CHANNEL_ID);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle("🌸 Tirage Légendaire !")
    .setDescription(`**${username}** vient d'obtenir **${itemName}** ✨`)
    .setThumbnail(imageUrl || null)
    .setTimestamp();
  await channel.send({ embeds: [embed] });
}

async function announceNewSignup(pseudo) {
  const channel = await client.channels.fetch(config.ANNOUNCE_CHANNEL_ID);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(0x88c9ff)
    .setDescription(`🎉 **${pseudo}** vient de rejoindre Takashi Exotic !`)
    .setTimestamp();
  await channel.send({ embeds: [embed] });
}

// -------------------- Polling Supabase --------------------
async function pollSupabase() {
  try {
    const { data: newProfiles } = await supabase
      .from("profiles")
      .select("pseudo, created_at")
      .order("created_at", { ascending: false })
      .limit(5);

    if (newProfiles?.length) {
      if (lastKnownProfileCreatedAt !== null) {
        const fresh = newProfiles.filter((p) => new Date(p.created_at) > new Date(lastKnownProfileCreatedAt));
        for (const p of fresh.reverse()) await announceNewSignup(p.pseudo || "Un aventurier");
      }
      lastKnownProfileCreatedAt = newProfiles[0].created_at;
    }

    const { data: newInventory } = await supabase
      .from("gatcha_inventory")
      .select("obtained_at, user_id, item_id, gatcha_items(name, rarity, image_url), profiles(pseudo)")
      .order("obtained_at", { ascending: false })
      .limit(5);

    if (newInventory?.length) {
      if (lastKnownInventoryTimestamp !== null) {
        const fresh = newInventory.filter((i) => new Date(i.obtained_at) > new Date(lastKnownInventoryTimestamp));
        for (const entry of fresh.reverse()) {
          if (entry.gatcha_items?.rarity === "légendaire") {
            await announceLegendary(entry.profiles?.pseudo || "Un aventurier", entry.gatcha_items.name, entry.gatcha_items.image_url);
          }
        }
      }
      lastKnownInventoryTimestamp = newInventory[0].obtained_at;
    }
  } catch (err) {
    console.error("Erreur de polling Supabase :", err.message);
  }
}

// -------------------- /gatcha --------------------
async function handleGatchaCommand(interaction) {
  const email = interaction.options.getString("email");
  await interaction.deferReply();

  const profile = await getProfileByEmail(email);
  if (!profile) {
    return interaction.editReply("❌ Aucun compte trouvé avec cet email sur takashi-exotic.ddo.jp/jeu/gatcha.");
  }

  const { data: wallet, error: walletErr } = await supabase
    .from("gatcha_wallet")
    .select("coins, last_regen")
    .eq("user_id", profile.id)
    .single();

  if (walletErr || !wallet) {
    return interaction.editReply("❌ Impossible de récupérer ton portefeuille.");
  }

  const { newCoins } = computeRegen(wallet.coins, wallet.last_regen);

  if (newCoins < config.GATCHA_DRAW_COST) {
    return interaction.editReply(`💰 Pas assez de coins ! Tu as **${newCoins}** coins, il en faut **${config.GATCHA_DRAW_COST}**.`);
  }

  let remainingCoins = newCoins - config.GATCHA_DRAW_COST;

  const rarity = pickRarity();
  const { data: itemsOfRarity, error: itemsErr } = await supabase
    .from("gatcha_items")
    .select("id, name, rarity, image_url, emoji")
    .eq("rarity", rarity);

  if (itemsErr || !itemsOfRarity?.length) {
    return interaction.editReply("❌ Erreur lors du tirage, réessaie plus tard.");
  }

  const drawnItem = itemsOfRarity[Math.floor(Math.random() * itemsOfRarity.length)];

  const { data: existing } = await supabase
    .from("gatcha_inventory")
    .select("user_id, item_id")
    .eq("user_id", profile.id)
    .eq("item_id", drawnItem.id)
    .maybeSingle();

  let isDuplicate = false;

  if (existing) {
    isDuplicate = true;
    remainingCoins += DUPLICATE_BONUS[rarity] || 0;
  } else {
    await supabase.from("gatcha_inventory").insert({
      user_id: profile.id,
      item_id: drawnItem.id,
      obtained_at: new Date().toISOString(),
    });
  }

  await supabase
    .from("gatcha_wallet")
    .update({ coins: remainingCoins, last_regen: new Date().toISOString() })
    .eq("user_id", profile.id);

  const embed = new EmbedBuilder()
    .setColor(rarity === "légendaire" ? 0xffd700 : 0xff9ecb)
    .setTitle(`${RARITY_EMOJI[rarity]} ${drawnItem.emoji || ""} ${drawnItem.name}`)
    .setDescription(isDuplicate ? `Doublon ! Converti en **+${DUPLICATE_BONUS[rarity]} coins** 🪙` : "Nouvelle carte ajoutée à ta collection ! 🎴")
    .setThumbnail(drawnItem.image_url || null)
    .setFooter({ text: `Solde restant : ${remainingCoins} coins` });

  await interaction.editReply({ embeds: [embed] });

  if (rarity === "légendaire" && !isDuplicate) {
    await announceLegendary(profile.pseudo, drawnItem.name, drawnItem.image_url);
  }
}

// -------------------- /solde --------------------
async function handleSoldeCommand(interaction) {
  const email = interaction.options.getString("email");
  await interaction.deferReply({ ephemeral: true });

  const profile = await getProfileByEmail(email);
  if (!profile) {
    return interaction.editReply("❌ Aucun compte trouvé avec cet email.");
  }

  const { data: wallet } = await supabase.from("gatcha_wallet").select("coins, last_regen").eq("user_id", profile.id).single();
  if (!wallet) return interaction.editReply("❌ Impossible de récupérer ton portefeuille.");

  const { newCoins } = computeRegen(wallet.coins, wallet.last_regen);
  await interaction.editReply(`🪙 **${profile.pseudo}** a **${newCoins} coins** disponibles.`);
}

// -------------------- Events --------------------
client.once(Events.ClientReady, async () => {
  console.log("Mei is ready");
  await client.application.commands.set([
    {
      name: "gatcha",
      description: "Tire une carte du Gatcha Takashi Exotic 🌸",
      options: [{ name: "email", description: "Email utilisé pour ton compte Gatcha", type: 3, required: true }],
    },
    {
      name: "solde",
      description: "Affiche ton solde de coins Gatcha",
      options: [{ name: "email", description: "Email utilisé pour ton compte Gatcha", type: 3, required: true }],
    },
  ]);
  console.log("Commandes slash enregistrees");
  updateJSTStatus();
  setInterval(updateJSTStatus, 60 * 1000);
  pollSupabase();
  setInterval(pollSupabase, config.POLL_INTERVAL_MS);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "gatcha") {
    if (interaction.channelId !== config.GATCHA_CHANNEL_ID) {
      return interaction.reply({ content: `🌸 Utilise cette commande dans <#${config.GATCHA_CHANNEL_ID}> !`, ephemeral: true });
    }
    await handleGatchaCommand(interaction);
  }

  if (interaction.commandName === "solde") {
    await handleSoldeCommand(interaction);
  }
});

client.login(config.DISCORD_TOKEN);
