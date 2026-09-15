// Shared mint execution used by /mint, the "Mint tokens" message context menu
// and the :mint: emoji reaction handler.
import { Client, Message, TextChannel } from "discord.js";
import { parseUnits } from "@wevm/viem";
import { ChainConfig, mintTokens, parseInsufficientGasError, SupportedChain } from "./blockchain.ts";
import { Nostr, URI } from "./nostr.ts";
import { getAccountAddressForToken } from "./citizenwallet.ts";
import { refreshTokenStats } from "./token-stats-cache.ts";
import type { GuildSettings, Token } from "../types.ts";

export type Recipient = {
  type: "discord" | "email";
  id: string; // Discord user ID or email address
  label: string; // Display label: <@id> or email
  accountId: string; // Prefixed identifier: "discord:id" or "email:addr"
};

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Parse recipients from free text: Discord mentions and/or email addresses.
export function parseRecipients(input: string): Recipient[] {
  const recipients: Recipient[] = [];
  const seen = new Set<string>();

  const mentionRegex = /<@!?(\d+)>/g;
  let match;
  while ((match = mentionRegex.exec(input)) !== null) {
    const key = `discord:${match[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      recipients.push({ type: "discord", id: match[1], label: `<@${match[1]}>`, accountId: key });
    }
  }

  const withoutMentions = input.replace(/<@!?\d+>/g, " ");
  const tokens = withoutMentions.split(/[\s,;]+/).filter(Boolean);
  for (const token of tokens) {
    const email = token.trim().toLowerCase();
    if (EMAIL_REGEX.test(email)) {
      const key = `email:${email}`;
      if (!seen.has(key)) {
        seen.add(key);
        recipients.push({ type: "email", id: email, label: email, accountId: key });
      }
    }
  }

  return recipients;
}

// Minimal structural view of a Discord message so this stays testable without discord.js objects.
export type MessageLike = {
  author: { id: string; bot?: boolean } | null;
  mentions: { users: { values(): Iterable<{ id: string; bot?: boolean }> } };
};

// Recipients implied by a message: its author first, then every mentioned user.
// Bots are skipped; `excludeUserIds` lets callers drop e.g. the person triggering the mint.
export function recipientsFromMessage(
  message: MessageLike,
  opts: { excludeUserIds?: string[] } = {},
): Recipient[] {
  const exclude = new Set(opts.excludeUserIds ?? []);
  const seen = new Set<string>();
  const recipients: Recipient[] = [];

  const add = (user: { id: string; bot?: boolean }) => {
    if (user.bot || exclude.has(user.id) || seen.has(user.id)) return;
    seen.add(user.id);
    recipients.push({
      type: "discord",
      id: user.id,
      label: `<@${user.id}>`,
      accountId: `discord:${user.id}`,
    });
  };

  if (message.author) add(message.author);
  for (const user of message.mentions.users.values()) add(user);
  return recipients;
}

export function getMintableTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.mintable === true);
}

export function formatAmount(amount: number): string {
  return amount.toLocaleString("en-US");
}

export function buildMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export type MintSource = {
  via: "command" | "context-menu" | "reaction";
  messageUrl?: string;
};

export type MintResult = {
  recipient: Recipient;
  success: boolean;
  hash?: string;
  error?: string;
};

export type ExecuteMintOptions = {
  client: Client;
  guildSettings: GuildSettings;
  token: Token;
  recipients: Recipient[];
  amount: number;
  description?: string;
  minterId: string;
  source?: MintSource;
};

// Mint `amount` tokens for each recipient, annotate each tx on Nostr and post to the
// transactions channel. Returns one result per recipient; never throws for a single failure.
export async function executeMint(opts: ExecuteMintOptions): Promise<MintResult[]> {
  const { client, guildSettings, token, recipients, amount, description, minterId, source } = opts;
  const chain = token.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;
  const results: MintResult[] = [];

  for (const recipient of recipients) {
    try {
      let hash: string | null;

      if (token.walletManager === "citizenwallet") {
        if (recipient.type === "email") {
          throw new Error("CitizenWallet does not support email recipients");
        }
        const recipientAddress = await getAccountAddressForToken(recipient.id, token);
        if (!recipientAddress) throw new Error("No wallet address found");
        hash = await mintTokens(
          chain,
          token.address,
          recipientAddress,
          amount.toString(),
          token.decimals,
        );
      } else {
        const { Token: OCToken } = await import("@opencollective/token-factory");
        const ocToken = new OCToken({
          name: token.name,
          symbol: token.symbol,
          chain: token.chain,
          tokenAddress: token.address,
        });
        const amountWei = parseUnits(amount.toFixed(token.decimals), token.decimals);
        hash = await ocToken.mintTo(amountWei, recipient.accountId);
      }

      if (!hash) {
        results.push({ recipient, success: false, error: "No hash returned" });
        continue;
      }

      results.push({ recipient, success: true, hash });

      try {
        const nostr = Nostr.getInstance();
        const tags: string[][] = [
          ["t", "mint"],
          ["amount", amount.toString()],
          ["token", tokenTag(token)],
        ];
        if (source) {
          tags.push(["via", source.via]);
          if (source.messageUrl) tags.push(["r", source.messageUrl]);
        }
        await nostr.publishMetadata(`ethereum:${chainId}:tx:${hash}` as URI, {
          content: description || `Minted ${amount} ${token.symbol} for ${recipient.label}`,
          tags,
        });
      } catch (error) {
        console.error("Error sending Nostr annotation:", error);
      }
    } catch (error) {
      console.error(`Error minting for ${recipient.label}:`, error);
      const gasErr = await parseInsufficientGasError(error, chain);
      const message = gasErr
        ? gasErr.formatMessage("mint")
        : error instanceof Error
        ? error.message
        : String(error);
      results.push({ recipient, success: false, error: message });
    }
  }

  const successful = results.filter((r) => r.success);
  const txChannelId = token.transactionsChannelId || guildSettings.channels?.transactions;
  if (successful.length > 0 && txChannelId) {
    try {
      const channel = (await client.channels.fetch(txChannelId)) as TextChannel;
      if (channel) {
        const tokenLink = tokenLinkFor(token);
        const lines = successful.map((r) =>
          `🪙 <@${minterId}> minted ${formatAmount(amount)} ${tokenLink} for ${r.recipient.label} [[tx]](<${txUrlFor(token, r.hash!)}>)`
        );
        let message = lines.join("\n");
        if (description) message += `\n📝 ${description}`;
        if (source?.messageUrl) message += `\n🔗 [context](<${source.messageUrl}>)`;
        await channel.send(message);
      }
    } catch (error) {
      console.error("Error sending message to transactions channel:", error);
    }
  }

  if (successful.length > 0) {
    refreshTokenStats(token.chain, token.address, token.decimals).catch(() => {});
  }

  return results;
}

// Public acknowledgement posted as a reply to the message that triggered a mint
// (context menu or reaction), so the recipients and the channel see it happened.
export async function announceMintOnMessage(
  message: Message,
  results: MintResult[],
  token: Token,
  amount: number,
  minterId: string,
): Promise<void> {
  const successful = results.filter((r) => r.success);
  if (successful.length === 0) return;
  const who = successful.map((r) => r.recipient.label).join(", ");
  const txs = successful.map((r) => `[tx](<${txUrlFor(token, r.hash!)}>)`).join(" ");
  const content =
    `🪙 <@${minterId}> minted ${formatAmount(amount)} ${tokenLinkFor(token)} for ${who} · ${txs}`;
  try {
    await message.reply({ content });
  } catch (error) {
    console.error("Error announcing mint on message:", error);
  }
  try {
    await message.react("✅");
  } catch {
    // Missing AddReactions permission — not worth failing over
  }
}

export function tokenTag(token: Token): string {
  return `ethereum:${ChainConfig[token.chain as SupportedChain].id}:address:${token.address.toLowerCase()}`;
}

export type ExistingMint = { txUri: string; createdAt: number; content: string };

// Has this Discord message already been rewarded with this token? Uses the Nostr
// annotations as the source of truth (they carry the message URL as an `r` tag), so
// this survives restarts and redeploys without any local state.
export async function findExistingMint(
  messageUrl: string,
  token: Token,
): Promise<ExistingMint | null> {
  let nostr: Nostr;
  try {
    nostr = Nostr.getInstance();
  } catch {
    return null; // Nostr not configured — nothing to check against
  }
  try {
    const events = await nostr.query({
      kinds: [1111],
      authors: [nostr.getPublicKey()],
      "#r": [messageUrl],
    });
    const tag = tokenTag(token);
    const match = events
      .filter((e) => e.tags.some((t) => t[0] === "t" && t[1] === "mint"))
      .filter((e) => e.tags.some((t) => t[0] === "token" && t[1] === tag))
      .sort((a, b) => a.created_at - b.created_at)[0];
    if (!match) return null;
    const txUri = match.tags.find((t) => t[0] === "i")?.[1] ?? "";
    return { txUri, createdAt: match.created_at, content: match.content };
  } catch (error) {
    console.error("[mint] Nostr lookup failed, assuming not minted:", error);
    return null;
  }
}

export function tokenLinkFor(token: Token): string {
  return `[${token.symbol}](<https://txinfo.xyz/${token.chain}/token/${token.address}>)`;
}

export function txUrlFor(token: Token, hash: string): string {
  return `https://txinfo.xyz/${token.chain}/tx/${hash}`;
}

// Human-readable summary of a mint run, shared by every entry point.
export function formatMintResults(
  results: MintResult[],
  token: Token,
  amount: number,
  description?: string,
): string {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const tokenLink = tokenLinkFor(token);
  let content = "";

  if (successful.length > 0) {
    content = successful
      .map((r) =>
        `✅ Minted ${formatAmount(amount)} ${tokenLink} for ${r.recipient.label} [[tx]](<${txUrlFor(token, r.hash!)}>)`
      )
      .join("\n");
    if (description) content += `\n📝 ${description}`;
  }

  if (failed.length > 0) {
    const lines = failed.map((r) => `${r.recipient.label}: ${r.error}`).join("\n");
    content += successful.length === 0 ? `❌ Failed to mint:\n${lines}` : `\n❌ Failed to mint for:\n${lines}`;
  }

  return content;
}
