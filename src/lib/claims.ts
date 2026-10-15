/**
 * Token claims: someone asks for tokens for a contribution (/claim, or Elinor's propose_claim), for
 * themselves or for others. The claim is posted in the token's transactions channel with Approve /
 * Reject buttons; it's a normal message, so anyone can react to it.
 *
 * - Approve: anyone who may /mint the token, except the requester and the recipients (another minter
 *   has to). Mints the amount to each recipient the same way /mint does, with the reason as
 *   description, tagged t:claim and the category.
 * - Reject: a minter, or the requester (withdrawing it), with an optional reason.
 * Claims are pending requests (kind "claim", pending-requests.ts): one decision only, survives
 * restarts, get_request_status works, and they expire after CLAIM_TTL_MS.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  GuildMember,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { loadGuildSettings } from "./utils.ts";
import { executeMint, type Recipient, txUrlFor } from "./mint.ts";
import { hasTokenPermission } from "../commands/mint.ts";
import { shopToken, tokens } from "./shop.ts";
import { categoryLabel, findCategory, tokenCategories } from "./tx-categories.ts";
import {
  type ClaimParams,
  countPendingFor,
  createRequest,
  getRequest,
  type PendingRequest,
  transition,
  updateRequest,
} from "./pending-requests.ts";
import type { GuildSettings, Token } from "../types.ts";

export const CLAIM_PREFIX = "claim:";
export const CLAIM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_CLAIM_RECIPIENTS = 20;
/** Per person and per claim, so a typo doesn't mint 200. */
export const MAX_CLAIM_PER_PERSON = 10;
const MAX_PENDING_CLAIMS = 10;

let mint = executeMint;
/** For tests: replace the mint. */
export function _setClaimMint(fn?: typeof executeMint) {
  mint = fn ?? executeMint;
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Throws a message people can read when the amount isn't acceptable. */
export function checkClaimAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("The amount must be more than 0.");
  if (Math.round(amount * 100) !== amount * 100) throw new Error("The amount can have at most 2 decimals.");
  if (amount > MAX_CLAIM_PER_PERSON) {
    throw new Error(`At most ${tokens(MAX_CLAIM_PER_PERSON)} per person in one claim. For more, ask a minter to /mint.`);
  }
}

/** A token category slug, or undefined for none. Throws for unknown ones. */
export function checkClaimCategory(category: string | undefined, symbol: string): string | undefined {
  if (!category?.trim()) return undefined;
  const found = findCategory(symbol, category);
  if (!found) throw new Error(`Unknown category "${category}". Categories: ${tokenCategories().map((c) => c.slug).join(", ")}.`);
  return found.slug;
}

/** Discord user ids mentioned in free text ("<@123> <@!456>"), in order, deduped. */
export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(/<@!?(\d{5,25})>/g)].map((m) => m[1]))];
}

/** The claim's token: CHT, else the only mintable token. */
export function claimToken(settings: GuildSettings | null | undefined): Token | null {
  const t = shopToken(settings);
  return t?.mintable ? t : null;
}

// ── The message ─────────────────────────────────────────────────────────────

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The claim body (without the status line). */
export function claimBody(p: { requesterId: string; recipientIds: string[]; amount: number; reason: string; category?: string; viaElinor?: boolean }): string {
  const n = p.recipientIds.length;
  const lines = [
    `🙋 **Token claim** by <@${p.requesterId}>${p.viaElinor ? " (via Elinor)" : ""}`,
    `**For:** ${p.recipientIds.map((id) => `<@${id}>`).join(", ")}`,
    `**Amount:** ${tokens(p.amount)}${n > 1 ? ` each, ${tokens(Number((p.amount * n).toFixed(2)))} in total` : ""}`,
    `**Reason:** ${p.reason}`,
  ];
  if (p.category) lines.push(`🏷️ ${categoryLabel(p.category)}`);
  return lines.join("\n");
}

export function pendingStatusLine(minterRoleId?: string): string {
  return `⏳ Waiting for a minter${minterRoleId ? ` (<@&${minterRoleId}>)` : ""} to approve. Anyone can react.`;
}

function claimButtons(id: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CLAIM_PREFIX}approve:${id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CLAIM_PREFIX}reject:${id}`).setLabel("Reject").setStyle(ButtonStyle.Secondary),
  );
}

// ── Creating a claim ────────────────────────────────────────────────────────

export type NewClaim = {
  client: Client;
  guildId: string;
  requesterId: string;
  /** Default: the requester. */
  recipientIds?: string[];
  amount: number;
  reason: string;
  category?: string;
  via: "command" | "elinor";
  /** Free text for the audit trail (Elinor's requestedBy). */
  requestedBy?: string;
};

async function member(guild: { members: { fetch(id: string): Promise<GuildMember> } }, id: string, role: string): Promise<GuildMember> {
  const m = /^\d{5,25}$/.test(id) ? await guild.members.fetch(id).catch(() => null) : null;
  if (!m) throw new Error(`Unknown ${role}: no member ${id} in this server`);
  if (m.user.bot) throw new Error(`${role} ${id} is a bot`);
  return m;
}

/** Validate, post the claim in the transactions channel, record it. Throws readable errors. */
export async function createClaim(c: NewClaim): Promise<{ request: PendingRequest; url: string }> {
  const settings = await loadGuildSettings(c.guildId);
  const token = claimToken(settings);
  if (!settings || !token) throw new Error("No token to claim is configured in this server");
  const reason = clean(c.reason ?? "", 300);
  if (!reason) throw new Error("A reason is required: what was the contribution?");
  checkClaimAmount(c.amount);
  const category = checkClaimCategory(c.category, token.symbol);

  const guild = await c.client.guilds.fetch(c.guildId).catch(() => null);
  if (!guild) throw new Error(`Unknown guild ${c.guildId}`);
  const requester = await member(guild, c.requesterId, "requester");
  const ids = [...new Set((c.recipientIds?.length ? c.recipientIds : [requester.id]).map(String))];
  if (ids.length > MAX_CLAIM_RECIPIENTS) throw new Error(`At most ${MAX_CLAIM_RECIPIENTS} people in one claim.`);
  const recipients = await Promise.all(ids.map((id) => member(guild, id, "recipient")));
  if (await countPendingFor(c.guildId, requester.id) >= MAX_PENDING_CLAIMS) {
    throw new Error(`<@${requester.id}> already has ${MAX_PENDING_CLAIMS} pending requests; wait for them to be decided.`);
  }

  const channelId = token.transactionsChannelId || settings.channels?.transactions;
  const channel = channelId ? await c.client.channels.fetch(channelId).catch(() => null) : null;
  if (!channel || !channel.isTextBased() || !("send" in channel)) throw new Error("The token's transactions channel isn't set up or visible to the bot");

  const params: ClaimParams = { tokenSymbol: token.symbol, recipientIds: recipients.map((m) => m.id), amount: c.amount, reason, ...(category ? { category } : {}) };
  const summary = claimBody({ requesterId: requester.id, recipientIds: params.recipientIds, amount: c.amount, reason, category, viaElinor: c.via === "elinor" });
  const request = await createRequest({
    kind: "claim",
    guildId: c.guildId,
    requestedBy: clean(c.requestedBy || `<@${requester.id}> via /claim`, 300),
    confirmerId: requester.id,
    requesterId: requester.id,
    approval: "any_minter",
    ...(token.minterRoleId ? { approvers: { roleId: token.minterRoleId } } : {}),
    params,
    summary,
  }, new Date(), CLAIM_TTL_MS);

  const message = await (channel as TextChannel).send({
    content: `${summary}\n\n${pendingStatusLine(token.minterRoleId)}`,
    components: [claimButtons(request.id)],
    allowedMentions: { users: [...new Set([requester.id, ...params.recipientIds])], roles: [] },
  }).catch(async (e) => {
    await updateRequest(c.guildId, request.id, (r) => {
      r.status = "failed";
      r.decidedAt = new Date().toISOString();
      r.error = `Could not post the claim: ${e?.message || e}`;
    });
    throw new Error(`Couldn't post the claim in the transactions channel (${e?.message || e})`);
  });
  const url = `https://discord.com/channels/${c.guildId}/${message.channelId}/${message.id}`;
  const saved = await updateRequest(c.guildId, request.id, (r) => {
    r.message = { channelId: message.channelId, messageId: message.id, dm: false, url };
  });
  return { request: saved ?? request, url };
}

// ── Approve / Reject ────────────────────────────────────────────────────────

/** Why this member can't approve, or null when they can. */
export function cannotApprove(r: Pick<PendingRequest, "requesterId" | "confirmerId" | "params">, m: GuildMember, token: Token): string | null {
  const p = r.params as ClaimParams;
  if (!hasTokenPermission(m, token.minterRoleId)) return "Only a minter can approve a claim.";
  if (m.id === (r.requesterId ?? r.confirmerId)) return "You asked for this claim: another minter has to approve it.";
  if (p.recipientIds.includes(m.id)) return "You're one of the recipients: another minter has to approve it.";
  return null;
}

async function context(interaction: ButtonInteraction | ModalSubmitInteraction, id: string) {
  const guildIds = [...interaction.client.guilds.cache.keys()];
  const r = await getRequest(id, interaction.guildId ? [interaction.guildId, ...guildIds] : guildIds);
  if (!r || r.kind !== "claim") return null;
  const settings = await loadGuildSettings(r.guildId);
  const token = settings?.tokens.find((t) => t.symbol === (r.params as ClaimParams).tokenSymbol);
  const m = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null;
  return { r, settings, token, member: m };
}

const closed = (r: PendingRequest) =>
  r.status === "pending" ? (Date.now() > new Date(r.expiresAt).getTime() ? "expired" : null) : r.status === "cancelled" ? "rejected" : r.status;

export async function handleClaimButton(interaction: ButtonInteraction): Promise<void> {
  const [action, id] = interaction.customId.slice(CLAIM_PREFIX.length).split(":");
  const ctx = await context(interaction, id);
  if (!ctx || !ctx.settings || !ctx.token || !ctx.member) {
    await interaction.reply({ content: "⚠️ This claim can't be found any more.", flags: MessageFlags.Ephemeral });
    return;
  }
  const { r, settings, token, member: m } = ctx;
  const done = closed(r);
  if (done) {
    await interaction.reply({ content: `This claim is already ${done}.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "reject") {
    const isRequester = m.id === (r.requesterId ?? r.confirmerId);
    if (!isRequester && !hasTokenPermission(m, token.minterRoleId)) {
      await interaction.reply({ content: "Only a minter, or the person who asked, can reject a claim.", flags: MessageFlags.Ephemeral });
      return;
    }
    const input = new TextInputBuilder().setCustomId("reason").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300);
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`${CLAIM_PREFIX}rejectmodal:${r.id}`)
        .setTitle(isRequester ? "Withdraw this claim" : "Reject this claim")
        .addLabelComponents(new LabelBuilder().setLabel("Reason (optional)").setTextInputComponent(input)),
    );
    return;
  }
  if (action !== "approve") return;

  const why = cannotApprove(r, m, token);
  if (why) {
    await interaction.reply({ content: why, flags: MessageFlags.Ephemeral });
    return;
  }
  const claimed = await transition(r.guildId, r.id, "confirmed", m.id);
  if (!claimed) {
    await interaction.reply({ content: "This claim was just decided by someone else.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.update({ content: `${r.summary}\n\n⏳ Approved by <@${m.id}>, minting…`, components: [], allowedMentions: { parse: [] } });

  const p = r.params as ClaimParams;
  try {
    const recipients: Recipient[] = p.recipientIds.map((uid) => ({ type: "discord", id: uid, label: `<@${uid}>`, accountId: `discord:${uid}` }));
    const results = await mint({
      client: interaction.client,
      guildSettings: settings,
      token,
      recipients,
      amount: p.amount,
      description: p.reason,
      minterId: m.id,
      source: { via: "claim", messageUrl: r.message?.url },
      category: p.category,
      extraTags: [["t", "claim"]],
    });
    const ok = results.filter((x) => x.success);
    const failed = results.filter((x) => !x.success);
    const lines = [`✅ Approved by <@${m.id}>`];
    if (ok.length) lines.push(`Minted ${tokens(p.amount)} for ${ok.map((x) => `${x.recipient.label} [[tx]](<${txUrlFor(token, x.hash!)}>)`).join(", ")}`);
    if (failed.length) lines.push(`⚠️ Not minted for ${failed.map((x) => `${x.recipient.label} (${x.error})`).join(", ")}`);
    await updateRequest(r.guildId, r.id, (x) => {
      x.status = ok.length ? "confirmed" : "failed";
      x.result = results.map((y) => ({ userId: y.recipient.id, success: y.success, txHash: y.hash ?? null, error: y.error ?? null }));
      if (!ok.length) x.error = failed.map((y) => y.error).join("; ");
    });
    await interaction.editReply({ content: `${r.summary}\n\n${lines.join("\n")}`, components: [], allowedMentions: { parse: [] } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRequest(r.guildId, r.id, (x) => {
      x.status = "failed";
      x.error = message;
    });
    await interaction.editReply({ content: `${r.summary}\n\n❌ Approved by <@${m.id}> but minting failed: ${message}`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  }
}

export async function handleClaimRejectModal(interaction: ModalSubmitInteraction): Promise<void> {
  const id = interaction.customId.slice(`${CLAIM_PREFIX}rejectmodal:`.length);
  const ctx = await context(interaction, id);
  if (!ctx || !ctx.token || !ctx.member) {
    await interaction.reply({ content: "⚠️ This claim can't be found any more.", flags: MessageFlags.Ephemeral });
    return;
  }
  const { r, token, member: m } = ctx;
  const isRequester = m.id === (r.requesterId ?? r.confirmerId);
  if (!isRequester && !hasTokenPermission(m, token.minterRoleId)) {
    await interaction.reply({ content: "Only a minter, or the person who asked, can reject a claim.", flags: MessageFlags.Ephemeral });
    return;
  }
  const reason = clean(interaction.fields.getTextInputValue("reason") || "", 300);
  const decided = await transition(r.guildId, r.id, "cancelled", m.id);
  if (!decided) {
    await interaction.reply({ content: `This claim is already ${closed(r) ?? "decided"}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  await updateRequest(r.guildId, r.id, (x) => {
    (x.params as ClaimParams).rejectReason = reason || undefined;
    x.result = { rejected: true, withdrawn: isRequester, reason: reason || null };
  });
  const status = `${isRequester ? "↩️ Withdrawn" : "❌ Rejected"} by <@${m.id}>${reason ? `: ${reason}` : ""}`;
  if (interaction.isFromMessage()) {
    await interaction.update({ content: `${r.summary}\n\n${status}`, components: [], allowedMentions: { parse: [] } });
  } else {
    await interaction.reply({ content: status, flags: MessageFlags.Ephemeral });
  }
}
