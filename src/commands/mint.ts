import { Interaction, TextChannel } from "discord.js";
import { mintTokens, SupportedChain, ChainConfig } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { Nostr, URI } from "../lib/nostr.ts";

// Parse user mentions from a string, returns array of user IDs
function parseUserMentions(input: string): string[] {
  const mentionRegex = /<@!?(\d+)>/g;
  const userIds: string[] = [];
  let match;
  while ((match = mentionRegex.exec(input)) !== null) {
    userIds.push(match[1]);
  }
  return userIds;
}

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

  const usersInput = interaction.options.getString("users");
  const amount = interaction.options.getNumber("amount");
  const message = interaction.options.getString("message") || undefined;

  if (!usersInput || !amount) {
    await interaction.reply({
      content: "❌ Missing required options.",
      ephemeral: true,
    });
    return;
  }

  const recipientUserIds = parseUserMentions(usersInput);
  
  if (recipientUserIds.length === 0) {
    await interaction.reply({
      content: "❌ No valid users found. Please mention users with @username.",
      ephemeral: true,
    });
    return;
  }

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    console.error("Guild settings not found");
    await interaction.reply({
      content: "❌ Guild settings not found.",
      ephemeral: true,
    });
    return;
  }

  // Defer reply since we might be minting for multiple users
  await interaction.deferReply({ ephemeral: true });

  const chain = guildSettings.contributionToken.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;
  const tokenSymbol = guildSettings.contributionToken.symbol;

  const results: { userId: string; success: boolean; hash?: string; error?: string }[] = [];

  // Mint for each user
  for (const recipientUserId of recipientUserIds) {
    try {
      const hash = await mintTokens(
        chain,
        guildSettings.contributionToken.address,
        recipientUserId,
        amount.toString(),
      );

      if (hash) {
        results.push({ userId: recipientUserId, success: true, hash });

        const txUri = `ethereum:${chainId}:tx:${hash}` as URI;

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
      } else {
        results.push({ userId: recipientUserId, success: false, error: "No hash returned" });
      }
    } catch (error) {
      console.error(`Error minting for user ${recipientUserId}:`, error);
      results.push({ userId: recipientUserId, success: false, error: String(error) });
    }
  }

  // Post to Discord transactions channel (single message for all users)
  const successfulMints = results.filter(r => r.success);
  if (successfulMints.length > 0 && guildSettings.channels?.transactions && interaction.guild) {
    try {
      const transactionsChannel = await interaction.guild.channels.fetch(
        guildSettings.channels.transactions,
      ) as TextChannel;

      if (transactionsChannel) {
        const recipientMentions = successfulMints.map(r => `<@${r.userId}>`).join(", ");
        let discordMessage = `🪙 <@${userId}> minted ${amount} ${tokenSymbol} each for ${recipientMentions}`;
        if (message) {
          discordMessage += `: ${message}`;
        }
        await transactionsChannel.send(discordMessage);
      }
    } catch (error) {
      console.error("Error sending message to transactions channel:", error);
    }
  }

  // Build reply message
  const successCount = successfulMints.length;
  const failCount = results.length - successCount;

  let replyContent = "";
  if (successCount > 0) {
    const recipientMentions = successfulMints.map(r => `<@${r.userId}>`).join(", ");
    replyContent = `✅ Minted ${amount} ${tokenSymbol} each for ${recipientMentions}`;
    if (message) {
      replyContent += `\n📝 ${message}`;
    }
  }
  
  if (failCount > 0) {
    const failedMints = results.filter(r => !r.success);
    const failedMentions = failedMints.map(r => `<@${r.userId}>`).join(", ");
    replyContent += `\n❌ Failed to mint for: ${failedMentions}`;
  }

  if (successCount === 0) {
    replyContent = "❌ Failed to mint tokens for all users.";
  }

  await interaction.editReply({
    content: replyContent,
  });
}
