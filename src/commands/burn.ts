import {
  AutocompleteInteraction,
  GuildMember,
  Interaction,
  MessageFlags,
  TextChannel,
} from "discord.js";
import {
  burnTokensFrom,
  ChainConfig,
  parseInsufficientGasError,
  SupportedChain,
} from "../lib/blockchain.ts";
import { parseUnits } from "@wevm/viem";
import { findTokenByInput, loadGuildSettings } from "../lib/utils.ts";
import { refreshTokenStats } from "../lib/token-stats-cache.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { getAccountAddressForToken } from "../lib/citizenwallet.ts";
import type { Token } from "../types.ts";
import { hasTokenPermission, parseRecipients, type Recipient } from "./mint.ts";



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
      content: "❌ No tokens configured. Run `/edit-tokens` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member as GuildMember;

  const burnableTokens = getBurnableTokens(guildSettings.tokens);

  if (burnableTokens.length === 0) {
    await interaction.reply({
      content: "❌ No burnable tokens configured.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get arguments
  const tokenSymbol = interaction.options.getString("token");
  const usersInput = interaction.options.getString("users", true);
  const amount = interaction.options.getNumber("amount", true);
  const description = interaction.options.getString("description") || undefined;

  // Find the token (default to only burnable token if not specified)
  const token = tokenSymbol
    ? findTokenByInput(burnableTokens, tokenSymbol)
    : burnableTokens.length === 1 ? burnableTokens[0] : null;
  if (!token) {
    const available = burnableTokens.map((t) => `\`${t.symbol}\``).join(", ");
    await interaction.reply({
      content: tokenSymbol
        ? `❌ Token \`${tokenSymbol}\` not found. Available: ${available}`
        : `❌ Multiple tokens available. Please specify one: ${available}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check permission using per-token minter role
  if (!hasTokenPermission(member, token.minterRoleId)) {
    await interaction.reply({
      content: "❌ You don't have permission to burn tokens.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Parse recipients (Discord mentions and/or email addresses)
  const recipients = parseRecipients(usersInput);
  if (recipients.length === 0) {
    await interaction.reply({
      content: "❌ No valid recipients found. Mention users with @username or enter an email address.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const chain = token.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;

  const results: {
    recipient: Recipient;
    success: boolean;
    hash?: string;
    error?: string;
  }[] = [];

  // Burn from each recipient
  for (const recipient of recipients) {
    try {
      let hash: string | null;

      if (token.walletManager === "citizenwallet") {
        if (recipient.type === "email") throw new Error("CitizenWallet does not support email recipients");
        const targetAddress =
          await getAccountAddressForToken(recipient.id, token);
        if (!targetAddress) throw new Error("No wallet address found");
        hash = await burnTokensFrom(
          chain, token.address, targetAddress,
          amount.toString(), token.decimals,
        );
      } else {
        // Default: opencollective token-factory
        const { Token: OCToken } = await import("@opencollective/token-factory");
        const ocToken = new OCToken({
          name: token.name, symbol: token.symbol,
          chain: token.chain, tokenAddress: token.address,
        });
        const amountWei = parseUnits(amount.toFixed(token.decimals), token.decimals);
        hash = await ocToken.burnFrom(amountWei, recipient.accountId);
      }

      if (hash) {
        results.push({ recipient, success: true, hash });

        const txUri = `ethereum:${chainId}:tx:${hash}` as URI;

        // Publish metadata to Nostr
        try {
          const nostr = Nostr.getInstance();
          const nostrContent =
            description || `Burned ${amount} ${token.symbol} from ${recipient.label}`;

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
          recipient,
          success: false,
          error: "No hash returned",
        });
      }
    } catch (error) {
      console.error(`Error burning from ${recipient.label}:`, error);
      const gasErr = await parseInsufficientGasError(error, chain);
      const message = gasErr
        ? gasErr.formatMessage("burn")
        : error instanceof Error
        ? error.message
        : String(error);
      results.push({
        recipient,
        success: false,
        error: message,
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
          return `🔥 <@${userId}> burned ${formattedAmount} ${tokenLink} from ${r.recipient.label} [[tx]](<${txUrl}>)`;
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
      return `🔥 Burned ${formattedAmount} ${tokenLink} from ${r.recipient.label} [[tx]](<${txUrl}>)`;
    });
    replyContent = burnLines.join("\n");
    if (description) {
      replyContent += `\n📝 ${description}`;
    }
  }

  if (failCount > 0) {
    const failedBurns = results.filter((r) => !r.success);
    const failedLines = failedBurns.map((r) => `${r.recipient.label}: ${r.error}`);
    replyContent += `\n❌ Failed to burn from:\n${failedLines.join("\n")}`;
  }

  if (successCount === 0) {
    replyContent = "❌ Failed to burn tokens from all users.";
  }

  await interaction.editReply({ content: replyContent });

  // Refresh token stats cache in background after successful burns
  if (successfulBurns.length > 0) {
    refreshTokenStats(token.chain, token.address, token.decimals).catch(() => {});
  }
}
