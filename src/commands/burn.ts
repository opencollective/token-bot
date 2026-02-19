import {
  AutocompleteInteraction,
  Interaction,
  MessageFlags,
  TextChannel,
} from "discord.js";
import { burnTokensFrom, SupportedChain, ChainConfig } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { getAccountAddressForToken } from "../lib/citizenwallet.ts";
import type { Token } from "../types.ts";

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

// Get burnable tokens (all tokens can be burned if bot has permission)
function getBurnableTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.mintable === true); // Same permission as mint for now
}

// Format number with thousand separators
function formatAmount(amount: number): string {
  return amount.toLocaleString("en-US");
}

// Handle autocomplete for token selection
export async function handleBurnAutocomplete(
  interaction: AutocompleteInteraction,
  guildId: string,
) {
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.respond([]);
    return;
  }

  const burnableTokens = getBurnableTokens(guildSettings.tokens);
  const focused = interaction.options.getFocused().toLowerCase();

  const choices = burnableTokens
    .filter(
      (t) =>
        t.symbol.toLowerCase().includes(focused) ||
        t.name.toLowerCase().includes(focused),
    )
    .map((t) => ({
      name: `${t.symbol} (${t.name})`,
      value: t.symbol,
    }))
    .slice(0, 25);

  await interaction.respond(choices);
}

export default async function handleBurnCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings || guildSettings.tokens.length === 0) {
    await interaction.reply({
      content: "❌ No tokens configured. Run `/add-token` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const burnableTokens = getBurnableTokens(guildSettings.tokens);

  if (burnableTokens.length === 0) {
    await interaction.reply({
      content: "❌ No burnable tokens configured.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get arguments
  const tokenSymbol = interaction.options.getString("token", true);
  const usersInput = interaction.options.getString("users", true);
  const amount = interaction.options.getNumber("amount", true);
  const description = interaction.options.getString("description") || undefined;

  // Find the token
  const token = burnableTokens.find(
    (t) => t.symbol.toLowerCase() === tokenSymbol.toLowerCase(),
  );
  if (!token) {
    const available = burnableTokens.map((t) => `\`${t.symbol}\``).join(", ");
    await interaction.reply({
      content: `❌ Token \`${tokenSymbol}\` not found. Available: ${available}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Parse user mentions
  const targetUserIds = parseUserMentions(usersInput);
  if (targetUserIds.length === 0) {
    await interaction.reply({
      content: "❌ No valid users found. Mention users with @username.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const chain = token.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;

  const results: {
    userId: string;
    success: boolean;
    hash?: string;
    error?: string;
  }[] = [];

  // Burn from each user
  for (const targetUserId of targetUserIds) {
    try {
      const targetAddress =
        await getAccountAddressForToken(targetUserId, token);

      const hash = await burnTokensFrom(
        chain,
        token.address,
        targetAddress,
        amount.toString(),
        token.decimals,
      );

      if (hash) {
        results.push({ userId: targetUserId, success: true, hash });

        const txUri = `ethereum:${chainId}:tx:${hash}` as URI;

        // Publish metadata to Nostr
        try {
          const nostr = Nostr.getInstance();
          const nostrContent =
            description || `Burned ${amount} ${token.symbol} from Discord user`;

          await nostr.publishMetadata(txUri, {
            content: nostrContent,
            tags: [
              ["t", "burn"],
              ["amount", amount.toString()],
            ],
          });
        } catch (error) {
          console.error("Error sending Nostr annotation:", error);
        }
      } else {
        results.push({
          userId: targetUserId,
          success: false,
          error: "No hash returned",
        });
      }
    } catch (error) {
      console.error(`Error burning from user ${targetUserId}:`, error);
      results.push({
        userId: targetUserId,
        success: false,
        error: String(error),
      });
    }
  }

  // Build links
  const tokenUrl = `https://txinfo.xyz/${chain}/token/${token.address}`;
  const tokenLink = `[${token.symbol}](<${tokenUrl}>)`;
  const formattedAmount = formatAmount(amount);

  // Post to Discord transactions channel
  const successfulBurns = results.filter((r) => r.success);
  const txChannelId = token.transactionsChannelId || guildSettings.channels?.transactions;
  if (successfulBurns.length > 0 && txChannelId) {
    try {
      const transactionsChannel = (await interaction.client.channels.fetch(
        txChannelId,
      )) as TextChannel;

      if (transactionsChannel) {
        const burnLines = successfulBurns.map((r) => {
          const txUrl = `https://txinfo.xyz/${chain}/tx/${r.hash}`;
          return `🔥 <@${userId}> burned ${formattedAmount} ${tokenLink} from <@${r.userId}> [[tx]](<${txUrl}>)`;
        });

        let discordMessage = burnLines.join("\n");
        if (description) {
          discordMessage += `\n📝 ${description}`;
        }
        await transactionsChannel.send(discordMessage);
      }
    } catch (error) {
      console.error("Error sending message to transactions channel:", error);
    }
  }

  // Build reply message
  const successCount = successfulBurns.length;
  const failCount = results.length - successCount;

  let replyContent = "";
  if (successCount > 0) {
    const burnLines = successfulBurns.map((r) => {
      const txUrl = `https://txinfo.xyz/${chain}/tx/${r.hash}`;
      return `🔥 Burned ${formattedAmount} ${tokenLink} from <@${r.userId}> [[tx]](<${txUrl}>)`;
    });
    replyContent = burnLines.join("\n");
    if (description) {
      replyContent += `\n📝 ${description}`;
    }
  }

  if (failCount > 0) {
    const failedBurns = results.filter((r) => !r.success);
    const failedLines = failedBurns.map((r) => `<@${r.userId}>: ${r.error}`);
    replyContent += `\n❌ Failed to burn from:\n${failedLines.join("\n")}`;
  }

  if (successCount === 0) {
    replyContent = "❌ Failed to burn tokens from all users.";
  }

  await interaction.editReply({ content: replyContent });
}
