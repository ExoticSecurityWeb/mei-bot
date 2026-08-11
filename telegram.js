const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const config = require("./config");

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

const DUPLICATE_BONUS = { commun: 20, rare: 40, "épique": 70, "légendaire": 150 };
const RARITY_WEIGHTS = { commun: 60, rare: 28, "épique": 10, "légendaire": 2 };
const RARITY_EMOJI = { commun: "⚪", rare: "🔵", "épique": "🟣", "légendaire": "🌟" };

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

function startTelegramBot() {
  if (!config.TELEGRAM_TOKEN) {
    console.log("TELEGRAM_TOKEN absent, bot Telegram non démarré.");
    return;
  }

  const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });
  console.log("Mei (Telegram) est prête");

  bot.onText(/\/gatcha(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const email = match[1]?.trim();

    if (!email) {
      return bot.sendMessage(chatId, "🌸 Utilise : /gatcha ton@email.com");
    }

    const profile = await getProfileByEmail(email);
    if (!profile) {
      return bot.sendMessage(chatId, "❌ Aucun compte trouvé avec cet email sur takashi-exotic.ddo.jp/jeu/gatcha.");
    }

    const { data: wallet, error: walletErr } = await supabase
      .from("gatcha_wallet")
      .select("coins, last_regen")
      .eq("user_id", profile.id)
      .single();

    if (walletErr || !wallet) {
      return bot.sendMessage(chatId, "❌ Impossible de récupérer ton portefeuille.");
    }

    const { newCoins } = computeRegen(wallet.coins, wallet.last_regen);

    if (newCoins < config.GATCHA_DRAW_COST) {
      return bot.sendMessage(chatId, `💰 Pas assez de coins ! Tu as ${newCoins} coins, il en faut ${config.GATCHA_DRAW_COST}.`);
    }

    let remainingCoins = newCoins - config.GATCHA_DRAW_COST;
    const rarity = pickRarity();

    const { data: itemsOfRarity, error: itemsErr } = await supabase
      .from("gatcha_items")
      .select("id, name, rarity, image_url, emoji")
      .eq("rarity", rarity);

    if (itemsErr || !itemsOfRarity?.length) {
      return bot.sendMessage(chatId, "❌ Erreur lors du tirage, réessaie plus tard.");
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

    const text = isDuplicate
      ? `${RARITY_EMOJI[rarity]} ${drawnItem.emoji || ""} *${drawnItem.name}*\nDoublon ! Converti en +${DUPLICATE_BONUS[rarity]} coins 🪙\n\nSolde restant : ${remainingCoins} coins`
      : `${RARITY_EMOJI[rarity]} ${drawnItem.emoji || ""} *${drawnItem.name}*\nNouvelle carte ajoutée à ta collection ! 🎴\n\nSolde restant : ${remainingCoins} coins`;

    bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  });

  bot.onText(/\/solde(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const email = match[1]?.trim();

    if (!email) {
      return bot.sendMessage(chatId, "🪙 Utilise : /solde ton@email.com");
    }

    const profile = await getProfileByEmail(email);
    if (!profile) {
      return bot.sendMessage(chatId, "❌ Aucun compte trouvé avec cet email.");
    }

    const { data: wallet } = await supabase.from("gatcha_wallet").select("coins, last_regen").eq("user_id", profile.id).single();
    if (!wallet) return bot.sendMessage(chatId, "❌ Impossible de récupérer ton portefeuille.");

    const { newCoins } = computeRegen(wallet.coins, wallet.last_regen);
    bot.sendMessage(chatId, `🪙 ${profile.pseudo} a ${newCoins} coins disponibles.`);
  });
}

module.exports = { startTelegramBot };
