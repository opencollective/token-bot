import {
  AutocompleteInteraction,
  Interaction,
  MessageFlags,
  TextChannel,
} from "discord.js";
import { mintTokens, SupportedChain, ChainConfig } from "../lib/blockchain.ts";
import { parseUnits } from "@wevm/viem";
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

// Get mintable tokens from settings
function getMintableTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.mintable === true);
}

// Format number with thousand separators
function formatAmount(amount: number): string {
  return amount.toLocaleString("en-US");
}

// Handle autocomplete for token selection
export async function handleMintAutocomplete(
  interaction: AutocompleteInteraction,
  guildId: string,
) {
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.respond([]);
    return;
  }

  const mintableTokens = getMintableTokens(guildSettings.tokens);
  const focused = interaction.options.getFocused().toLowerCase();

  const choices = mintableTokens
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

export default async function handleMintCommand(
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

  const mintableTokens = getMintableTokens(guildSettings.tokens);

  if (mintableTokens.length === 0) {
    await interaction.reply({
      content:
        "❌ No mintable tokens configured. Add a token with `/add-token` first.",
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
  const token = mintableTokens.find(
    (t) => t.symbol.toLowerCase() === tokenSymbol.toLowerCase(),
  );
  if (!token) {
    const available = mintableTokens.map((t) => `\`${t.symbol}\``).join(", ");
    await interaction.reply({
      content: `❌ Token \`${tokenSymbol}\` not found. Available: ${available}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Parse user mentions
  const recipientUserIds = parseUserMentions(usersInput);
  if (recipientUserIds.length === 0) {
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

  // Mint for each user
  for (const recipientUserId of recipientUserIds) {
    try {
      let hash: string | null;

      if (token.walletManager === "opencollective") {
        const { Token: OCToken } = await import("@opencollective/token-factory");
        const ocToken = new OCToken({
          name: token.name, symbol: token.symbol,
          chain: token.chain, tokenAddress: token.address,
        });
        const amountWei = parseUnits(amount.toFixed(token.decimals), token.decimals);
        hash = await ocToken.mintTo(amountWei, `discord:${recipientUserId}`);
      } else {
        const recipientAddress =
          await getAccountAddressForToken(recipientUserId, token);
        hash = await mintTokens(
          chain, token.address, recipientAddress,
          amount.toString(), token.decimals,
        );
      }

      if (hash) {
        results.push({ userId: recipientUserId, success: true, hash });

        const txUri = `ethereum:${chainId}:tx:${hash}` as URI;

        // Publish metadata to Nostr
        try {
          const nostr = Nostr.getInstance();
          const nostrContent =
            description || `Minted ${amount} ${token.symbol} for Discord user`;

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
        results.push({
          userId: recipientUserId,
          success: false,
          error: "No hash returned",
        });
      }
    } catch (error) {
      console.error(`Error minting for user ${recipientUserId}:`, error);
      results.push({
        userId: recipientUserId,
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
  const successfulMints = results.filter((r) => r.success);
  const txChannelId = token.transactionsChannelId || guildSettings.channels?.transactions;
  if (successfulMints.length > 0 && txChannelId) {
    try {
      const transactionsChannel = (await interaction.client.channels.fetch(
        txChannelId,
      )) as TextChannel;

      if (transactionsChannel) {
        // Build message for each recipient with tx link
        const mintLines = successfulMints.map((r) => {
          const txUrl = `https://txinfo.xyz/${chain}/tx/${r.hash}`;
          return `🪙 <@${userId}> minted ${formattedAmount} ${tokenLink} for <@${r.userId}> [[tx]](<${txUrl}>)`;
        });
        
        let discordMessage = mintLines.join("\n");
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
  const successCount = successfulMints.length;
  const failCount = results.length - successCount;

  let replyContent = "";
  if (successCount > 0) {
    const mintLines = successfulMints.map((r) => {
      const txUrl = `https://txinfo.xyz/${chain}/tx/${r.hash}`;
      return `✅ Minted ${formattedAmount} ${tokenLink} for <@${r.userId}> [[tx]](<${txUrl}>)`;
    });
    replyContent = mintLines.join("\n");
    if (description) {
      replyContent += `\n📝 ${description}`;
    }
  }

  if (failCount > 0) {
    const failedMints = results.filter((r) => !r.success);
    const failedMentions = failedMints.map((r) => `<@${r.userId}>`).join(", ");
    replyContent += `\n❌ Failed to mint for: ${failedMentions}`;
  }

  if (successCount === 0) {
    replyContent = "❌ Failed to mint tokens for all users.";
  }

  await interaction.editReply({ content: replyContent });
}
