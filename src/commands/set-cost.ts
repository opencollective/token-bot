import { Client as _Client, Interaction } from "discord.js";

export default async function handleSetCostCommand(
  _client: _Client,
  interaction: Interaction,
) {
  console.log("handleSetCostCommand");
  if (!interaction.isChatInputCommand() || !interaction.options) {
    console.error("Interaction is not a chat input command or has no options");
    return;
  }

  const roleId = interaction.options.getRole("role")?.id;
  const amount = interaction.options.getNumber("amount");
  const frequency = interaction.options.getString("frequency");
  const roleName = interaction.options.getRole("role")?.name;

  if (!roleId || amount === null || !frequency) {
    await interaction.reply({
      content: "❌ Missing required options.",
      ephemeral: true,
    });
    return;
  }

  const guild = {
    id: interaction.guildId,
    name: interaction.guild?.name,
    icon: interaction.guild?.icon,
  };
  const user = {
    id: interaction.user.id,
    username: interaction.user.username,
    globalName: interaction.user.globalName,
    avatar: interaction.user.avatar,
  };
  console.log(
    `Setting cost for role ${roleName} (roleId: ${roleId}) with amount ${amount} and frequency ${frequency}`,
  );
  console.log(">>> guild", guild);
  console.log(">>> user", user);
  await interaction.reply({
    content: `✅ Cost set for role <@&${roleId}> to ${amount} tokens (${frequency})`,
    ephemeral: true,
  });
}
