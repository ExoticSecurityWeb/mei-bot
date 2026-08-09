const ws = require("ws");
global.WebSocket = ws;

const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: {
    persistSession: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
  global: {
    fetch: (...args) => import("node-fetch").then(({default: fetch}) => fetch(...args)),
  },
});

// Solution specifique demandee par l'erreur : passer le transport ws
const { RealtimeClient } = require("@supabase/realtime-js");
// Mais supabase-js l'encapsule. On va forcer le global.

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const DUPLICATE_BONUS = { common: 20, rare: 40, epic: 70, legendary: 150 };
const RARITY_WEIGHTS = { common: 60, rare: 25, epic: 12, legendary: 3 };
const RARITY_EMOJI = { common: "⚪", rare: "🔵", epic: "🟣", legendary: "🌟" };

let lastKnownProfileCreatedAt = null;
let lastKnownInventoryId = null;

function updateJSTStatus() {
  const now = new Date();
  const jstTime = new Intl.DateTimeFormat("fr-FR", { timeZone: config.TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(now);
  client.user.setActivity(`🕐 ${jstTime} JST à Tokyo`, { type: 4 });
}

function computeRegen(coins, lastRegenISO) {
  const lastRegen = new Date(lastRegenISO);
  const now = new Date();
  const hoursElapsed = (now - lastRegen) / (1000 * 60 * 60);
  const regenAmount = Math.floor(hoursElapsed * 100);
  return { newCoins: Math.min(100, coins + regenAmount), regenApplied: regenAmount > 0 };
}

function pickRarity() {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (const [rarity, weight] of Object.entries(RARITY_WEIGHTS)) {
    if (roll < weight) return rarity;
    roll -= weight;
  }
  return "common";
}

async function announceLegendary(username, itemName, imageUrl) {
  const channel = await client.channels.fetch(config.ANNOUNCE_CHANNEL_ID);
  if (!channel) return;
  const embed = new EmbedBuilder().setColor(0xffd700).setTitle("🌸 Tirage Légendaire !").setDescription(`**${username}** vient d'obtenir **${itemName}** ✨`).setThumbnail(imageUrl || null).setTimestamp();
  await channel.send({ embeds: [embed] });
}

async function announceNewSignup(username) {
  const channel = await client.channels.fetch(config.ANNOUNCE_CHANNEL_ID);
  if (!channel) return;
  const embed = new EmbedBuilder().setColor(0x88c9ff).setDescription(`🎉 **${username}** vient de rejoindre Takashi Exotic !`).setTimestamp();
  await channel.send({ embeds: [embed] });
}

async function pollSupabase() {
  try {
    const { data: newProfiles } = await supabase.from("profiles").select("username, created_at").order("created_at", { ascending: false }).limit(5);
    if (newProfiles && newProfiles.length > 0) {
      if (lastKnownProfileCreatedAt !== null) {
        const fresh = newProfiles.filter(p => new Date(p.created_at) > new Date(lastKnownProfileCreatedAt));
        for (const p of fresh.reverse()) await announceNewSignup(p.username || "Un aventurier");
      }
      lastKnownProfileCreatedAt = newProfiles[0].created_at;
    }
    const { data: newInventory } = await supabase.from("gatcha_inventory").select("id, gatcha_items(name, rarity, image_url), profiles(username)").order("id", { ascending: false }).limit(5);
    if (newInventory && newInventory.length > 0) {
      if (lastKnownInventoryId !== null) {
        const fresh = newInventory.filter(i => i.id > lastKnownInventoryId);
        for (const entry of fresh.reverse()) {
          if (entry.gatcha_items?.rarity === "legendary") await announceLegendary(entry.profiles?.username || "Un aventurier", entry.gatcha_items.name, entry.gatcha_items.image_url);
        }
      }
      lastKnownInventoryId = newInventory[0].id;
    }
  } catch (err) { console.error("Polling error:", err.message); }
}

async function handleGatchaCommand(interaction) {
  const email = interaction.options.getString("email");
  await interaction.deferReply();
  const { data: profile } = await supabase.from("profiles").select("id, username").eq("email", email).single();
  if (!profile) return interaction.editReply("❌ Aucun compte trouvé.");
  const { data: wallet } = await supabase.from("gatcha_wallet").select("coins, last_regen").eq("profile_id", profile.id).single();
  const { newCoins } = computeRegen(wallet.coins, wallet.last_regen);
  if (newCoins < config.GATCHA_DRAW_COST) return interaction.editReply(`💰 Pas assez de coins (Solde: ${newCoins}).`);
  const rarity = pickRarity();
  const { data: items } = await supabase.from("gatcha_items").select("id, name, rarity, image_url").eq("rarity", rarity);
  const drawnItem = items[Math.floor(Math.random() * items.length)];
  const { data: existing } = await supabase.from("gatcha_inventory").select("id, quantity").eq("profile_id", profile.id).eq("item_id", drawnItem.id).maybeSingle();
  let finalCoins = newCoins - config.GATCHA_DRAW_COST;
  let isDuplicate = false;
  if (existing) {
    isDuplicate = true; finalCoins += DUPLICATE_BONUS[rarity] || 0;
    await supabase.from("gatcha_inventory").update({ quantity: existing.quantity + 1 }).eq("id", existing.id);
  } else {
    await supabase.from("gatcha_inventory").insert({ profile_id: profile.id, item_id: drawnItem.id, quantity: 1 });
  }
  await supabase.from("gatcha_wallet").update({ coins: finalCoins, last_regen: new Date().toISOString() }).eq("profile_id", profile.id);
  const embed = new EmbedBuilder().setColor(rarity === "legendary" ? 0xffd700 : 0xff9ecb).setTitle(`${RARITY_EMOJI[rarity]} ${drawnItem.name}`).setDescription(isDuplicate ? `Doublon ! +${DUPLICATE_BONUS[rarity]} coins` : "Nouvelle carte !").setThumbnail(drawnItem.image_url || null).setFooter({ text: `Solde : ${finalCoins} coins` });
  await interaction.editReply({ embeds: [embed] });
  if (rarity === "legendary" && !isDuplicate) await announceLegendary(profile.username, drawnItem.name, drawnItem.image_url);
}

client.once(Events.ClientReady, () => { console.log("Mei is ready"); updateJSTStatus(); setInterval(updateJSTStatus, 60000); pollSupabase(); setInterval(pollSupabase, config.POLL_INTERVAL_MS); });
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === "gatcha") { if (i.channelId !== config.GATCHA_CHANNEL_ID) return i.reply({ content: "Mauvais salon", ephemeral: true }); await handleGatchaCommand(i); }
  if (i.commandName === "solde") {
    const email = i.options.getString("email"); await i.deferReply({ ephemeral: true });
    const { data: p } = await supabase.from("profiles").select("id, username").eq("email", email).single();
    if (!p) return i.editReply("❌ Aucun compte.");
    const { data: w } = await supabase.from("gatcha_wallet").select("coins, last_regen").eq("profile_id", p.id).single();
    const { newCoins } = computeRegen(w.coins, w.last_regen); await i.editReply(`🪙 **${p.username}** a **${newCoins} coins**.`);
  }
});
client.login(config.DISCORD_TOKEN);