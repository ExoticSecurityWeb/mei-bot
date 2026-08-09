const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const config = require("./config");

const commands = [
  new SlashCommandBuilder()
    .setName("gatcha")
    .setDescription("Tire une carte du Gatcha Takashi Exotic 🌸")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("solde")
    .setDescription("Affiche ton solde de coins Gatcha")
    .addStringOption((opt) =>
      opt
        .setName("email")
        .setDescription("Email utilisé pour ton compte Gatcha")
        .setRequired(true)
    )
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Enregistrement des commandes slash...");
    const app = await rest.get(Routes.oauth2CurrentApplication());
    await rest.put(Routes.applicationCommands(app.id), { body: commands });
    console.log("Commandes enregistrées avec succès pour", app.name);
  } catch (error) {
    console.error(error);
  }
})();