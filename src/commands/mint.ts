import { Client, Interaction } from "discord.js";
import { mintTokens, SupportedChain } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { URI } from "../lib/nostr.ts";
export default async function handleMintCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  console.log("handleMintCommand");
  if (!interaction.isChatInputCommand() || !interaction.options) {
    console.error("Interaction is not a chat input command or has no options");
    return;
  }

  const recipientUserId = interaction.options.getUser("user")?.id;
  const amount = interaction.options.getNumber("amount");
  if (!userId || !amount) {
    await interaction.reply({
      content: "❌ Missing required options.",
      ephemeral: true,
    });
    return;
  }

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    console.error("Guild settings not found");
    return;
  }

  const hash = await mintTokens(
    guildSettings.contributionToken.chain as SupportedChain,
    guildSettings.contributionToken.address,
    recipientUserId as string,
    amount.toString(),
  );

  if (!hash) {
    console.error("Failed to mint tokens");
    return;
  }

  const txUri = `ethereum:${guildSettings.contributionToken.chain}:tx:${hash}` as URI;

  await interaction.reply({
    content: `✅ <@${userId}> minted ${amount} tokens for user <@${recipientUserId}>`,
    ephemeral: true,
  });
}
