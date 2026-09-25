// Emoji reactions that move tokens, always confirmed with buttons:
//   :mint: (minter role)  → mint a fixed amount for the message author + mentions
//   :coin: 🪙 (any member) → send a fixed amount from the reactor's own balance to author + mentions
// The bot replies to the message with Confirm / Cancel. Cancel or timeout removes the reaction.
// Mint dedupe relies on the Nostr annotations (message URL as `r` tag) rather than local files.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  Guild,
  GuildEmoji,
  Message,
  MessageFlags,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  PermissionsBitField,
  User,
} from "discord.js";
import { Buffer } from "node:buffer";
import { formatUnits } from "@wevm/viem";
import { loadGuildSettings } from "./utils.ts";
import {
  buildMessageUrl,
  executeMint,
  findExistingMint,
  formatAmount,
  getMintableTokens,
  type MintResult,
  type Recipient,
  recipientsFromMessage,
  tokenLinkFor,
  txUrlFor,
} from "./mint.ts";
import { executeSend, getSenderBalance, type SendResult, toUnits } from "./send.ts";
import { hasTokenPermission } from "../commands/mint.ts";
import type { GuildSettings, Token } from "../types.ts";

export const DEFAULT_MINT_EMOJI_NAME = "mint";
export const DEFAULT_SEND_EMOJI = "🪙"; // :coin:
export const MINT_EMOJI_ASSET_PATH = new URL("../../assets/mint-emoji.png", import.meta.url);
const PROMPT_TTL_MS = 5 * 60 * 1000;
const DESCRIPTION_MAX = 200;

export type ReactionKind = "mint" | "send";
export type EmojiLike = { name: string | null; id: string | null };

// Normalise a configured emoji value: "mint", ":mint:", "🪙", "123456789", or "<:mint:123456789>".
export function parseEmojiConfig(value: string): { name?: string; id?: string } {
  const custom = value.match(/^<a?:(\w+):(\d+)>$/);
  if (custom) return { name: custom[1], id: custom[2] };
  if (/^\d+$/.test(value)) return { id: value };
  return { name: value.replace(/^:(\w+):$/, "$1") };
}

function emojiMatches(configValue: string, emoji: EmojiLike): boolean {
  const cfg = parseEmojiConfig(configValue);
  if (cfg.id) return emoji.id === cfg.id;
  return emoji.name === cfg.name;
}

// Which token (if any) does this emoji act on, and how?
// Explicit per-token config wins. If no mintable token declares an emoji for a kind, the
// default (:mint: / 🪙) maps to the first mintable token so it works without config.
export function resolveReactionAction(
  tokens: Token[],
  emoji: EmojiLike,
): { kind: ReactionKind; token: Token } | null {
  const mintable = getMintableTokens(tokens);
  if (mintable.length === 0) return null;

  const mintConfigured = mintable.filter((t) => t.mintEmoji);
  for (const token of mintConfigured) {
    if (emojiMatches(token.mintEmoji!, emoji)) return { kind: "mint", token };
  }
  const sendConfigured = mintable.filter((t) => t.sendEmoji);
  for (const token of sendConfigured) {
    if (emojiMatches(token.sendEmoji!, emoji)) return { kind: "send", token };
  }

  if (mintConfigured.length === 0 && emoji.name === DEFAULT_MINT_EMOJI_NAME) {
    return { kind: "mint", token: mintable[0] };
  }
  if (sendConfigured.length === 0 && emoji.name === DEFAULT_SEND_EMOJI) {
    return { kind: "send", token: mintable[0] };
  }
  return null;
}

// Custom emoji names the bot should make sure exist in a guild.
export function requiredMintEmojiNames(settings: GuildSettings): string[] {
  const mintable = getMintableTokens(settings.tokens);
  if (mintable.length === 0) return [];
  const names = new Set<string>();
  const configured = mintable.filter((t) => t.mintEmoji);
  if (configured.length === 0) names.add(DEFAULT_MINT_EMOJI_NAME);
  for (const token of configured) {
    const cfg = parseEmojiConfig(token.mintEmoji!);
    if (cfg.name && !cfg.id) names.add(cfg.name);
  }
  return [...names];
}

// ── Pending confirmations (in memory; a restart simply expires them) ────────

type PendingAction = {
  id: string;
  kind: ReactionKind;
  guildId: string;
  actorId: string;
  token: Token;
  recipients: Recipient[];
  amount: number;
  description?: string;
  sourceMessage: Message;
  sourceMessageUrl: string;
  reaction: MessageReaction;
  promptMessage?: Message;
  timer: number;
};

export const pendingActions = new Map<string, PendingAction>();
// Mints currently executing, keyed by message+token, to close the window between two stewards confirming at once.
const inFlightMints = new Set<string>();

function pendingKeyFor(kind: ReactionKind, messageId: string, actorId: string, token: Token): string {
  return `${kind}:${messageId}:${actorId}:${token.chain}:${token.address.toLowerCase()}`;
}

function findPending(kind: ReactionKind, messageId: string, actorId: string, token: Token) {
  const key = pendingKeyFor(kind, messageId, actorId, token);
  for (const p of pendingActions.values()) {
    if (pendingKeyFor(p.kind, p.sourceMessage.id, p.actorId, p.token) === key) return p;
  }
  return null;
}

async function removeReaction(reaction: MessageReaction, userId: string) {
  try {
    await reaction.users.remove(userId);
  } catch {
    // Needs "Manage Messages"; log once so the admin knows why the emoji stayed
    console.warn("[reactions] Could not remove reaction (missing Manage Messages permission?)");
  }
}

async function dmUser(user: User | PartialUser, content: string) {
  try {
    await user.send(content);
  } catch {
    // DMs closed
  }
}

function labels(recipients: Recipient[]): string {
  return recipients.map((r) => r.label).join(", ");
}

function fmtUnits(value: bigint, token: Token): string {
  return Number(formatUnits(value, token.decimals)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ── Reaction added ──────────────────────────────────────────────────────────

export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;

  try {
    if (reaction.partial) reaction = await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch (error) {
    console.error("[reactions] Could not fetch partial reaction/message:", error);
    return;
  }

  const message = reaction.message as Message;
  const guild = message.guild;
  const guildId = message.guildId;
  if (!guild || !guildId) return;

  const settings = await loadGuildSettings(guildId);
  if (!settings) return;

  const action = resolveReactionAction(settings.tokens, reaction.emoji);
  if (!action) return;
  const { kind, token } = action;

  let member;
  try {
    member = await guild.members.fetch(user.id);
  } catch {
    return;
  }

  if (kind === "mint" && !hasTokenPermission(member, token.minterRoleId)) {
    const roleHint = token.minterRoleId ? `the <@&${token.minterRoleId}> role` : "admin permissions";
    await removeReaction(reaction, user.id);
    await dmUser(user, `Only members with ${roleHint} can mint ${token.symbol} with :${reaction.emoji.name}:. Use 🪙 to send from your own balance instead.`);
    return;
  }
  if (kind === "send" && token.senderRoleId && !member.roles.cache.has(token.senderRoleId)) {
    await removeReaction(reaction, user.id);
    await dmUser(user, `Only members with the <@&${token.senderRoleId}> role can send ${token.symbol} with 🪙.`);
    return;
  }

  if (findPending(kind, message.id, user.id, token)) return; // already asked

  const recipients = recipientsFromMessage(message, { excludeUserIds: [user.id] });
  if (recipients.length === 0) {
    await removeReaction(reaction, user.id);
    await dmUser(user, `Nothing to ${kind}: that message has no author or mentions other than you.`);
    return;
  }

  const sourceMessageUrl = buildMessageUrl(guildId, message.channelId, message.id);
  const amount = kind === "mint" ? token.mintReactionAmount ?? 1 : token.sendReactionAmount ?? 1;
  const total = amount * recipients.length;
  const tokenLink = tokenLinkFor(token);
  let prompt: string;

  if (kind === "mint") {
    const existing = await findExistingMint(sourceMessageUrl, token);
    if (existing) {
      await removeReaction(reaction, user.id);
      const when = new Date(existing.createdAt * 1000).toISOString().slice(0, 10);
      await dmUser(user, `That message was already rewarded with ${token.symbol} on ${when}. Right-click → Apps → Mint tokens if you want to mint more.`);
      return;
    }
    prompt = `<@${user.id}> mint **${formatAmount(amount)} ${tokenLink}** for ${labels(recipients)}?`;
  } else {
    const wallet = await getSenderBalance(user.id, token);
    if (!wallet) {
      await removeReaction(reaction, user.id);
      await dmUser(user, `Could not find your ${token.symbol} wallet.`);
      return;
    }
    const needed = toUnits(total, token);
    if (wallet.balance < needed) {
      await removeReaction(reaction, user.id);
      await dmUser(user, `Insufficient ${token.symbol}: sending ${formatAmount(amount)} to ${recipients.length} people needs ${formatAmount(total)}, you have ${fmtUnits(wallet.balance, token)}.`);
      return;
    }
    prompt = `<@${user.id}> send **${formatAmount(amount)} ${tokenLink}** ${recipients.length > 1 ? "each " : ""}to ${labels(recipients)}?` +
      (recipients.length > 1 ? ` (total ${formatAmount(total)}, balance ${fmtUnits(wallet.balance, token)})` : ` (balance ${fmtUnits(wallet.balance, token)})`);
  }

  const id = crypto.randomUUID();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rx_confirm:${id}`).setLabel(kind === "mint" ? "Mint" : "Send").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rx_cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );

  const content = (message.content || "").replace(/\s+/g, " ").trim();
  const pending: PendingAction = {
    id,
    kind,
    guildId,
    actorId: user.id,
    token,
    recipients,
    amount,
    description: content ? content.slice(0, DESCRIPTION_MAX) : undefined,
    sourceMessage: message,
    sourceMessageUrl,
    reaction,
    timer: setTimeout(() => expirePending(id), PROMPT_TTL_MS),
  };
  pendingActions.set(id, pending);

  try {
    pending.promptMessage = await message.reply({
      content: `${prompt}\n-# Only <@${user.id}> can confirm · expires in 5 minutes`,
      components: [row],
      allowedMentions: { users: [user.id], repliedUser: false },
    });
  } catch (error) {
    console.error("[reactions] Could not post confirmation prompt:", error);
    clearTimeout(pending.timer);
    pendingActions.delete(id);
    await removeReaction(reaction, user.id);
  }
}

async function expirePending(id: string) {
  const pending = pendingActions.get(id);
  if (!pending) return;
  pendingActions.delete(id);
  await pending.promptMessage?.delete().catch(() => {});
  await removeReaction(pending.reaction, pending.actorId);
}

// ── Confirm / Cancel buttons ────────────────────────────────────────────────

export async function handleReactionButton(interaction: ButtonInteraction): Promise<void> {
  const [action, id] = interaction.customId.split(":");
  const pending = pendingActions.get(id);

  if (!pending) {
    await interaction.update({ content: "⌛ This request expired.", components: [] }).catch(() => {});
    setTimeout(() => interaction.message.delete().catch(() => {}), 10_000);
    return;
  }

  if (interaction.user.id !== pending.actorId) {
    await interaction.reply({
      content: `Only <@${pending.actorId}> can confirm or cancel this.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "rx_cancel") {
    clearTimeout(pending.timer);
    pendingActions.delete(id);
    await interaction.message.delete().catch(() => {});
    await removeReaction(pending.reaction, pending.actorId);
    return;
  }

  if (action !== "rx_confirm") return;

  clearTimeout(pending.timer);
  pendingActions.delete(id);
  const { kind, token, recipients, amount, actorId, sourceMessage, sourceMessageUrl, description } = pending;
  const client = interaction.client as Client;
  const settings = await loadGuildSettings(pending.guildId);
  if (!settings) {
    await interaction.update({ content: "❌ Settings not found.", components: [] });
    return;
  }

  await interaction.update({ content: `⏳ ${kind === "mint" ? "Minting" : "Sending"}…`, components: [] });

  let results: (MintResult | SendResult)[];
  if (kind === "mint") {
    const flightKey = `${sourceMessage.id}:${token.chain}:${token.address.toLowerCase()}`;
    if (inFlightMints.has(flightKey) || (await findExistingMint(sourceMessageUrl, token))) {
      await interaction.editReply({ content: `⚠️ This message was already rewarded with ${token.symbol}.` });
      await removeReaction(pending.reaction, actorId);
      return;
    }
    inFlightMints.add(flightKey);
    try {
      results = await executeMint({
        client,
        guildSettings: settings,
        token,
        recipients,
        amount,
        description,
        minterId: actorId,
        source: { via: "reaction", messageUrl: sourceMessageUrl },
      });
    } finally {
      inFlightMints.delete(flightKey);
    }
  } else {
    results = await executeSend({
      client,
      guildSettings: settings,
      token,
      senderId: actorId,
      recipients,
      amount,
      description,
      source: { via: "reaction", messageUrl: sourceMessageUrl },
    });
  }

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const verb = kind === "mint" ? "minted" : "sent";
  const emoji = kind === "mint" ? "🪙" : "💸";
  let content = "";
  if (successful.length > 0) {
    const txs = successful.map((r) => `[tx](<${txUrlFor(token, r.hash!)}>)`).join(" ");
    content = `${emoji} <@${actorId}> ${verb} ${formatAmount(amount)} ${tokenLinkFor(token)} ${kind === "send" ? "to" : "for"} ${labels(successful.map((r) => r.recipient))} · ${txs}`;
  }
  if (failed.length > 0) {
    content += `${content ? "\n" : ""}❌ Failed for ${failed.map((r) => `${r.recipient.label} (${r.error})`).join(", ")}`;
  }

  // Post the acknowledgement as a fresh reply so recipients get notified (edits don't ping),
  // and drop the prompt.
  await interaction.message.delete().catch(() => {});
  await sourceMessage
    .reply({ content, allowedMentions: { users: successful.map((r) => r.recipient.id), repliedUser: false } })
    .catch((err) => console.error("[reactions] Could not post acknowledgement:", err));

  if (successful.length === 0) {
    await removeReaction(pending.reaction, actorId);
  } else {
    await sourceMessage.react("✅").catch(() => {});
  }
}

// ── Emoji setup ─────────────────────────────────────────────────────────────

// Create the :mint: emoji in a guild if it doesn't exist yet. Needs the
// "Create Expressions" permission; logs a clear hint when it's missing.
export async function ensureMintEmoji(guild: Guild, name: string): Promise<GuildEmoji | null> {
  try {
    const emojis = await guild.emojis.fetch();
    const existing = emojis.find((e) => e.name === name);
    if (existing) return existing;

    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(PermissionsBitField.Flags.ManageGuildExpressions)) {
      console.warn(
        `[mint-emoji] Missing "Create Expressions" permission in ${guild.name}; upload assets/mint-emoji.png manually as :${name}:`,
      );
      return null;
    }

    const attachment = await Deno.readFile(MINT_EMOJI_ASSET_PATH);
    const created = await guild.emojis.create({
      attachment: Buffer.from(attachment),
      name,
      reason: "Token bot: emoji used to mint tokens by reaction",
    });
    console.log(`[mint-emoji] Created :${name}: (${created.id}) in ${guild.name}`);
    return created;
  } catch (error) {
    console.error(`[mint-emoji] Could not ensure :${name}: in ${guild.name}:`, error);
    return null;
  }
}

export async function ensureMintEmojis(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const settings = await loadGuildSettings(guild.id);
    if (!settings) continue;
    for (const name of requiredMintEmojiNames(settings)) {
      await ensureMintEmoji(guild, name);
    }
  }
}
