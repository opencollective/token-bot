import {
  AutocompleteInteraction,
  GuildMember,
  Interaction,
  MessageFlags,
  PermissionsBitField,
  TextChannel,
} from "discord.js";
import {
  ChainConfig,
  mintTokens,
  parseInsufficientGasError,
  SupportedChain,
} from "../lib/blockchain.ts";
import { parseUnits } from "@wevm/viem";
import { findTokenByInput, loadGuildSettings } from "../lib/utils.ts";
import { refreshTokenStats } from "../lib/token-stats-cache.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { getAccountAddressForToken } from "../lib/citizenwallet.ts";
import type { Token } from "../types.ts";

// Check if user has permission to mint/burn (admin or mintRoleId)
export function hasTokenPermission(member: GuildMember, mintRoleId?: string): boolean {
  // Admins always have permission
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return true;
  }
  // Check if user has the mint role
  if (mintRoleId && member.roles.cache.has(mintRoleId)) {
    return true;
  }
  return false;
}

// Parse user mentions from a string, returns array of user IDs
export type Recipient = {
  type: "discord" | "email";
  id: string; // Discord user ID or email address
  label: string; // Display label: <@id> or email
  accountId: string; // Prefixed identifier: "discord:id" or "email:addr"
};

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseRecipients(input: string): Recipient[] {
  const recipients: Recipient[] = [];
  const seen = new Set<string>();

  // Extract Discord mentions
  const mentionRegex = /<@!?(\d+)>/g;
  let match;
  while ((match = mentionRegex.exec(input)) !== null) {
    const key = `discord:${match[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      recipients.push({
        type: "discord",
        id: match[1],
        label: `<@${match[1]}>`,
        accountId: key,
      });
    }
  }

  // Extract email addresses (anything that looks like an email outside of mentions)
  const withoutMentions = input.replace(/<@!?\d+>/g, " ");
  const tokens = withoutMentions.split(/[\s,;]+/).filter(Boolean);
  for (const token of tokens) {
    const email = token.trim().toLowerCase();
    if (EMAIL_REGEX.test(email)) {
      const key = `email:${email}`;
      if (!seen.has(key)) {
        seen.add(key);
        recipients.push({
          type: "email",
          id: email,
          label: email,
          accountId: key,
        });
      }
    }
  }

  return recipients;
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
      content: "❌ No tokens configured. Run `/edit-tokens` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member as GuildMember;

  const mintableTokens = getMintableTokens(guildSettings.tokens);

  if (mintableTokens.length === 0) {
    await interaction.reply({
      content:
        "❌ No mintable tokens configured. Add a token with `/edit-tokens` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get arguments
  const tokenSymbol = interaction.options.getString("token");
  const usersInput = interaction.options.getString("users", true);
  const amount = interaction.options.getNumber("amount", true);
  const description = interaction.options.getString("description") || undefined;

  // Find the token (default to only mintable token if not specified)
  const token = tokenSymbol
    ? findTokenByInput(mintableTokens, tokenSymbol)
    : mintableTokens.length === 1 ? mintableTokens[0] : null;
  if (!token) {
    const available = mintableTokens.map((t) => `\`${t.symbol}\``).join(", ");
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
      content: "❌ You don't have permission to mint tokens.",
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

  // Mint for each recipient
  for (const recipient of recipients) {
    try {
      let hash: string | null;

      if (token.walletManager === "citizenwallet") {
        if (recipient.type === "email") throw new Error("CitizenWallet does not support email recipients");
        const recipientAddress =
          await getAccountAddressForToken(recipient.id, token);
        if (!recipientAddress) throw new Error("No wallet address found");
        hash = await mintTokens(
          chain, token.address, recipientAddress,
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
        hash = await ocToken.mintTo(amountWei, recipient.accountId);
      }

      if (hash) {
        results.push({ recipient, success: true, hash });

        const txUri = `ethereum:${chainId}:tx:${hash}` as URI;

        // Publish metadata to Nostr
        try {
          const nostr = Nostr.getInstance();
          const nostrContent =
            description || `Minted ${amount} ${token.symbol} for ${recipient.label}`;

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
          recipient,
          success: false,
          error: "No hash returned",
        });
      }
    } catch (error) {
      console.error(`Error minting for ${recipient.label}:`, error);
      const gasErr = await parseInsufficientGasError(error, chain);
      const message = gasErr
        ? gasErr.formatMessage("mint")
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
  const successfulMints = results.filter((r) => r.success);
  const txChannelId = token.transactionsChannelId || guildSettings.channels?.transactions;
  if (successfulMints.length > 0 && txChannelId) {
    try {
      const transactionsChannel = (await interaction.client.channels.fetch(
        txChannelId,
      )) as TextChannel;

      if (transactionsChannel) {
        const mintLines = successfulMints.map((r) => {
          const txUrl = `https://txinfo.xyz/${chain}/tx/${r.hash}`;
          return `🪙 <@${userId}> minted ${formattedAmount} ${tokenLink} for ${r.recipient.label} [[tx]](<${txUrl}>)`;
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
      return `✅ Minted ${formattedAmount} ${tokenLink} for ${r.recipient.label} [[tx]](<${txUrl}>)`;
    });
    replyContent = mintLines.join("\n");
    if (description) {
      replyContent += `\n📝 ${description}`;
    }
  }

  if (failCount > 0) {
    const failedMints = results.filter((r) => !r.success);
    const failedLines = failedMints.map((r) => `${r.recipient.label}: ${r.error}`);
    if (successCount === 0) {
      replyContent = `❌ Failed to mint:\n${failedLines.join("\n")}`;
    } else {
      replyContent += `\n❌ Failed to mint for:\n${failedLines.join("\n")}`;
    }
  }

  await interaction.editReply({ content: replyContent });

  // Refresh token stats cache in background after successful mints
  if (successfulMints.length > 0) {
    refreshTokenStats(token.chain, token.address, token.decimals).catch(() => {});
  }
}
