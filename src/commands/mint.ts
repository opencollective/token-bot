import { Interaction, TextChannel } from "discord.js";
import { mintTokens, SupportedChain, ChainConfig } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { Nostr, URI } from "../lib/nostr.ts";

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
  const message = interaction.options.getString("message") || undefined;

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
    await interaction.reply({
      content: "❌ Failed to mint tokens.",
      ephemeral: true,
    });
    return;
  }

  const chain = guildSettings.contributionToken.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;
  const txUri = `ethereum:${chainId}:tx:${hash}` as URI;
  const tokenSymbol = guildSettings.contributionToken.symbol;

  // Post to Discord transactions channel
  if (guildSettings.channels?.transactions && interaction.guild) {
    try {
      const transactionsChannel = await interaction.guild.channels.fetch(
        guildSettings.channels.transactions,
      ) as TextChannel;

      if (transactionsChannel) {
        let discordMessage = `🪙 <@${userId}> minted ${amount} ${tokenSymbol} for <@${recipientUserId}>`;
        if (message) {
          discordMessage += `: ${message}`;
        }
        await transactionsChannel.send(discordMessage);
      }
    } catch (error) {
      console.error("Error sending message to transactions channel:", error);
    }
  }

  // Publish metadata to Nostr
  try {
    const nostr = Nostr.getInstance();
    const nostrContent = message || `Minted ${amount} ${tokenSymbol} for Discord user`;

    await nostr.publishMetadata(txUri, {
      content: nostrContent,
      tags: [
        ["t", "mint"],
        ["amount", amount.toString()],
      ],
    });
  } catch (error) {
    console.error("Error sending Nostr annotation:", error);
  }

  let replyContent = `✅ <@${userId}> minted ${amount} ${tokenSymbol} for <@${recipientUserId}>`;
  if (message) {
    replyContent += `\n📝 ${message}`;
  }

  await interaction.reply({
    content: replyContent,
    ephemeral: true,
  });
}
