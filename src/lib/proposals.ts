/**
 * Proposals from Elinor (via MCP): mint, shift sign-up, room booking.
 *
 * A propose_* call only creates a pending request and posts a Confirm/Cancel message, in the
 * channel where Elinor was asked or by DM. Only the right person's click runs it, through the same
 * code as /mint, /shifts and /book:
 *   mint          → the confirmer must be allowed to mint (checked again on click) → executeMint
 *   shift_signup  → the member themselves → signUpForShift + confirmation email, like /shifts
 *   room_booking  → the member themselves → the /book flow, prefilled, at its payment step
 * Requests expire after 24 hours. Every proposal and outcome is logged in the guild's log channel.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  Guild,
  GuildMember,
  Message,
  MessageFlags,
  PermissionsBitField,
  TextChannel,
} from "discord.js";
import { findTokenByInput, loadGuildFile, loadGuildSettings } from "./utils.ts";
import { executeMint, formatAmount, formatMintResults, getMintableTokens, type Recipient } from "./mint.ts";
import { hasTokenPermission } from "../commands/mint.ts";
import { GoogleCalendarClient } from "./googlecalendar.ts";
import { getUser, getUserEmail, saveUser } from "./user-emails.ts";
import { hourlyRates, ratesFromPrices } from "./booking-email.ts";
import { hhmm, longDay } from "./shift-email.ts";
import { bookableFromMessage, checkBookableFrom } from "./room-rules.ts";
import {
  type CalendarEvent,
  isCancelledShiftEvent,
  logShiftAction,
  notifyShiftSignup,
  parseShiftSignups,
  type ShiftsSettings,
  signUpForShift,
} from "../commands/shifts.ts";
import { startPrefilledBooking } from "../commands/book.ts";
import {
  countPendingFor,
  createRequest,
  findExpired,
  getRequest,
  type MintParams,
  type PendingRequest,
  publicStatus,
  type RoomBookingParams,
  type ShiftSignupParams,
  transition,
  updateRequest,
} from "./pending-requests.ts";
import type { Product } from "../types.ts";

const SHIFTS_LOG_CHANNEL_ID = "1484493597901455370";
/** Members-only requests (propose_mint): the member role per guild. Guilds not listed aren't restricted. */
export const MEMBER_ROLE_BY_GUILD: Record<string, string> = {
  "1280532848604086365": "1280559675292778617", // Commons Hub Brussels
};
const MAX_APPROVER_MENTIONS = 5;
const MAX_PENDING_PER_CONFIRMER = 10;
const MAX_HOURS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const BUTTON_PREFIX = "preq_";

let client: Client | null = null;
export function setProposalsClient(c: Client) {
  client = c;
}
function requireClient(): Client {
  if (!client) throw new Error("Discord client not ready");
  return client;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const TZ = "Europe/Brussels";

export function whenText(start: Date, end: Date, tz = TZ): string {
  return `${longDay(start, tz)}, ${hhmm(start, tz)}–${hhmm(end, tz)}`;
}

function parseIso(value: unknown, name: string): Date {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required (ISO 8601)`);
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new Error(`${name} is not a valid ISO 8601 date: ${value}`);
  return d;
}

function checkSpan(start: Date, end: Date, now = new Date()) {
  if (end <= start) throw new Error("end must be after start");
  if (end.getTime() - start.getTime() > MAX_HOURS * 3600000) throw new Error(`Can't be longer than ${MAX_HOURS} hours`);
  if (start.getTime() < now.getTime() - 5 * 60000) throw new Error("start is in the past");
}

async function getGuild(guildId: string): Promise<Guild> {
  const guild = await requireClient().guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error(`Unknown guild ${guildId}`);
  return guild;
}

async function getMember(guild: Guild, userId: string, role = "user"): Promise<GuildMember> {
  const m = /^\d{5,25}$/.test(userId) ? await guild.members.fetch(userId).catch(() => null) : null;
  if (!m) throw new Error(`Unknown ${role}: no member ${userId} in this server`);
  if (m.user.bot) throw new Error(`${role} ${userId} is a bot`);
  return m;
}

const nameOf = (m: GuildMember) => m.displayName || m.user.globalName || m.user.username;

async function loadShiftsSettings(guildId: string): Promise<ShiftsSettings> {
  const s = await loadGuildFile(guildId, "shifts-settings.json") as ShiftsSettings | null;
  if (!s?.calendarId) throw new Error("Shifts are not configured for this server");
  return s;
}

async function loadProducts(guildId: string): Promise<Product[]> {
  return ((await loadGuildFile(guildId, "products.json")) as unknown as Product[] | null) ?? [];
}

/** Log channel: the guild's logs channel, else #shifts. */
async function log(guildId: string, text: string) {
  try {
    const settings = await loadGuildSettings(guildId);
    const channelId = settings?.channels?.logs || SHIFTS_LOG_CHANNEL_ID;
    const channel = await requireClient().channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) {
      await (channel as TextChannel).send({ content: text, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    console.error("[proposals] could not log:", error);
  }
}

// ── Read tools ──────────────────────────────────────────────────────────────

export async function listRooms(input: { guildId: string }) {
  const products = await loadProducts(input.guildId);
  return {
    timezone: (await loadGuildSettings(input.guildId))?.guild?.timezone || TZ,
    note: "Euro prices are per hour, excl. 21% VAT. Members pay with their own balance in the token they choose.",
    rooms: products.filter((p) => p.type === "room" && p.calendarId).map((p) => ({
      slug: p.slug,
      name: p.name,
      capacity: p.capacity ?? null,
      prices: p.price.map((x) => ({ token: x.token, amountPerHour: x.amount })),
      summary: hourlyRates(ratesFromPrices(p.price)),
      bookableFrom: p.bookableFrom ?? null,
      ...(p.bookableFrom ? { rule: bookableFromMessage(p) } : {}),
    })),
  };
}

export async function checkRoomAvailability(input: { guildId: string; room: string; start: string; end: string }) {
  const start = parseIso(input.start, "start"), end = parseIso(input.end, "end");
  if (end <= start) throw new Error("end must be after start");
  const product = (await loadProducts(input.guildId)).find((p) => p.slug === input.room);
  if (!product?.calendarId) throw new Error(`Unknown room "${input.room}". Use list_rooms for the slugs.`);
  const tz = (await loadGuildSettings(input.guildId))?.guild?.timezone || TZ;
  const tooEarly = checkBookableFrom(product, start, tz);
  const events = await new GoogleCalendarClient().listEvents(product.calendarId, start, end) as CalendarEvent[];
  const conflicts = events.filter((e) => e.start?.dateTime && new Date(e.start.dateTime) < end && new Date(e.end.dateTime) > start);
  return {
    room: product.slug,
    available: conflicts.length === 0 && !tooEarly,
    ...(tooEarly ? { reason: tooEarly } : {}),
    conflicts: conflicts.map((e) => ({ title: e.summary || "Busy", start: e.start.dateTime, end: e.end.dateTime })),
  };
}

export async function listUpcomingShifts(input: { guildId: string; days?: number }) {
  const settings = await loadShiftsSettings(input.guildId);
  const days = Math.min(31, Math.max(1, input.days ?? 7));
  const from = new Date(), to = new Date(Date.now() + days * 86400000);
  const events = await new GoogleCalendarClient().listEvents(settings.calendarId, from, to) as CalendarEvent[];
  return {
    timezone: settings.timezone,
    standardSlots: settings.slots,
    maxSignupsPerSlot: settings.maxSignupsPerSlot,
    reward: `${settings.rewardAmountPerHour} ${settings.rewardTokenSymbol} per hour`,
    note: "Any start/end works for propose_shift_signup; only the standard slots are published on the community relays.",
    shifts: events.filter((e) => e.id && e.start?.dateTime && !isCancelledShiftEvent(e)).map((e) => {
      const signups = parseShiftSignups(e.description || "");
      return {
        eventId: e.id,
        start: e.start.dateTime,
        end: e.end.dateTime,
        summary: e.summary || "",
        spotsLeft: Math.max(0, settings.maxSignupsPerSlot - signups.length),
        signups: signups.map((s) => ({
          discordUserId: s.discordUserId,
          displayName: (s.discordUserId && getUser(input.guildId, s.discordUserId)?.displayName) || s.username,
        })),
      };
    }),
  };
}

export async function getRequestStatus(input: { requestId: string }) {
  const guildIds = client ? [...client.guilds.cache.keys()] : [];
  const r = await getRequest(String(input.requestId), guildIds);
  if (!r) throw new Error(`Unknown request ${input.requestId}`);
  return publicStatus(r);
}

// ── Proposal tools ──────────────────────────────────────────────────────────

type Common = { guildId: string; requestedBy: string; channelId?: string; replyToMessageId?: string };

export function isMember(m: GuildMember, guildId: string): boolean {
  const role = MEMBER_ROLE_BY_GUILD[guildId];
  if (!role) return true;
  return m.roles.cache.has(role) || m.permissions.has(PermissionsBitField.Flags.Administrator);
}

/** Who to ping when any minter may approve: the minter role, else up to 5 admins (who can always mint). */
async function minterApprovers(guild: Guild, minterRoleId?: string): Promise<{ roleId?: string; userIds?: string[] }> {
  if (minterRoleId) return { roleId: minterRoleId };
  const all = await guild.members.fetch().catch(() => null);
  const admins = all
    ? [...all.values()].filter((m) => !m.user.bot && m.permissions.has(PermissionsBitField.Flags.Administrator)).slice(0, MAX_APPROVER_MENTIONS)
    : [];
  return { userIds: admins.map((m) => m.id) };
}

export function approverMentions(a: PendingRequest["approvers"]): string {
  if (a?.roleId) return `<@&${a.roleId}>`;
  return (a?.userIds ?? []).map((id) => `<@${id}>`).join(" ") || "an admin";
}

async function guardPending(guildId: string, confirmerId: string) {
  if (await countPendingFor(guildId, confirmerId) >= MAX_PENDING_PER_CONFIRMER) {
    throw new Error(`<@${confirmerId}> already has ${MAX_PENDING_PER_CONFIRMER} pending requests; wait for them to be answered or to expire`);
  }
}

export async function proposeMint(input: Common & {
  requesterUserId?: string;
  confirmerUserId?: string;
  recipientUserIds: string[];
  amount: number;
  token?: string;
  description?: string;
}) {
  const guild = await getGuild(input.guildId);
  const requesterId = input.requesterUserId || input.confirmerUserId;
  if (!requesterId) throw new Error("requesterUserId is required: the Discord user who asked for the tokens");
  const requester = await getMember(guild, requesterId, "requester");
  if (!isMember(requester, input.guildId)) throw new Error("Only members can request tokens.");

  const settings = await loadGuildSettings(input.guildId);
  const mintable = getMintableTokens(settings?.tokens ?? []);
  if (mintable.length === 0) throw new Error("No mintable token is configured in this server");
  const token = input.token ? findTokenByInput(mintable, input.token) : mintable.length === 1 ? mintable[0] : null;
  if (!token) {
    const available = mintable.map((t) => t.symbol).join(", ");
    throw new Error(input.token ? `Unknown or non-mintable token "${input.token}". Mintable: ${available}` : `Several tokens are mintable; pass token (one of: ${available})`);
  }
  if (!(input.amount > 0) || !Number.isFinite(input.amount)) throw new Error("amount must be a positive number");

  // Who approves: a named minter, else the requester when they can mint, else any minter.
  let approval: "confirmer" | "any_minter" = "confirmer";
  let confirmerId = requester.id;
  let approvers: PendingRequest["approvers"];
  if (input.confirmerUserId && input.confirmerUserId !== requester.id) {
    const confirmer = await getMember(guild, input.confirmerUserId, "confirmer");
    if (!hasTokenPermission(confirmer, token.minterRoleId)) {
      const role = token.minterRoleId ? `the <@&${token.minterRoleId}> role` : "admin permissions";
      throw new Error(`${nameOf(confirmer)} can't mint ${token.symbol}: it needs ${role}. Leave confirmerUserId out to let any minter approve.`);
    }
    confirmerId = confirmer.id;
  } else if (!hasTokenPermission(requester, token.minterRoleId)) {
    approval = "any_minter";
    approvers = await minterApprovers(guild, token.minterRoleId);
    if (!input.channelId) {
      throw new Error(`${nameOf(requester)} can't mint ${token.symbol}, so a minter must approve: pass the channelId (and replyToMessageId) where the request was made.`);
    }
  }

  const recipientIds = [...new Set(input.recipientUserIds.map(String))];
  const recipients = await Promise.all(recipientIds.map((id) => getMember(guild, id, "recipient")));
  await guardPending(input.guildId, requester.id);

  const params: MintParams = { tokenSymbol: token.symbol, recipientIds: recipients.map((m) => m.id), amount: input.amount, description: input.description?.trim() || undefined };
  const summary = `Mint **${formatAmount(input.amount)} ${token.symbol}**${recipients.length > 1 ? " each" : ""} for ${recipients.map((m) => `<@${m.id}>`).join(", ")}` +
    (params.description ? `\n📝 ${params.description}` : "");
  return await propose({ ...input, kind: "mint", confirmerId, requesterId: requester.id, approval, approvers, params, summary });
}

export async function proposeShiftSignup(input: Common & { userId: string; eventId?: string; start?: string; end?: string; email?: string }) {
  const guild = await getGuild(input.guildId);
  const member = await getMember(guild, input.userId, "member");
  const settings = await loadShiftsSettings(input.guildId);

  let start: Date, end: Date, existing: CalendarEvent | undefined;
  if (input.eventId) {
    const events = await new GoogleCalendarClient().listEvents(settings.calendarId, new Date(), new Date(Date.now() + 62 * 86400000)) as CalendarEvent[];
    existing = events.find((e) => e.id === input.eventId);
    if (!existing) throw new Error(`No upcoming shift with eventId ${input.eventId}. Use list_upcoming_shifts.`);
    start = new Date(existing.start.dateTime);
    end = new Date(existing.end.dateTime);
  } else {
    if (!input.start || !input.end) throw new Error("Pass eventId, or start and end");
    start = parseIso(input.start, "start");
    end = parseIso(input.end, "end");
    const events = await new GoogleCalendarClient().listEvents(settings.calendarId, new Date(start.getTime() - 60000), new Date(end.getTime() + 60000)) as CalendarEvent[];
    existing = events.find((e) => Math.abs(new Date(e.start.dateTime).getTime() - start.getTime()) < 60000 && Math.abs(new Date(e.end.dateTime).getTime() - end.getTime()) < 60000);
  }
  checkSpan(start, end);
  if (existing && !isCancelledShiftEvent(existing)) {
    const signups = parseShiftSignups(existing.description || "");
    if (signups.some((s) => s.discordUserId === member.id)) throw new Error(`${nameOf(member)} is already signed up for this shift`);
    if (signups.length >= settings.maxSignupsPerSlot) throw new Error("This shift is full");
  }
  const email = input.email?.trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) throw new Error(`"${input.email}" is not a valid email`);
  await guardPending(input.guildId, member.id);

  const hours = (end.getTime() - start.getTime()) / 3600000;
  const reward = Number((hours * settings.rewardAmountPerHour).toFixed(2));
  const params: ShiftSignupParams = { start: start.toISOString(), end: end.toISOString(), calendarEventId: existing?.id, email };
  const summary = `Sign <@${member.id}> up for a caretaking shift on **${whenText(start, end, settings.timezone)}**\n🪙 Reward: ${reward} ${settings.rewardTokenSymbol}` +
    (email ? `\n📧 Confirmation email to ${email}` : getUserEmail(input.guildId, member.id) ? "" : "\n📧 No email on file: no confirmation email");
  return await propose({ ...input, kind: "shift_signup", confirmerId: member.id, params, summary });
}

export async function proposeRoomBooking(input: Common & {
  userId: string;
  room: string;
  start: string;
  end: string;
  title: string;
  guestName?: string;
  guestEmail?: string;
}) {
  const guild = await getGuild(input.guildId);
  const member = await getMember(guild, input.userId, "member");
  const product = (await loadProducts(input.guildId)).find((p) => p.slug === input.room);
  if (!product?.calendarId) throw new Error(`Unknown room "${input.room}". Use list_rooms for the slugs.`);
  const start = parseIso(input.start, "start"), end = parseIso(input.end, "end");
  checkSpan(start, end);
  const tooEarly = checkBookableFrom(product, start, (await loadGuildSettings(input.guildId))?.guild?.timezone || TZ);
  if (tooEarly) throw new Error(tooEarly);
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  if (minutes % 15 !== 0) throw new Error("Bookings go by 15 minutes: adjust start or end");

  const guestEmail = input.guestEmail?.trim().toLowerCase();
  const guestName = input.guestName?.trim();
  if (guestEmail && !EMAIL_RE.test(guestEmail)) throw new Error(`"${input.guestEmail}" is not a valid email`);
  if (guestEmail && !guestName) throw new Error("guestName is required with guestEmail");
  if (guestName && !guestEmail) throw new Error("guestEmail is required to book for a guest");

  const availability = await checkRoomAvailability({ guildId: input.guildId, room: input.room, start: input.start, end: input.end });
  if (!availability.available) {
    if (availability.reason) throw new Error(availability.reason);
    throw new Error(`${product.name} is not free then: ${availability.conflicts.map((c) => `${c.title} ${c.start}–${c.end}`).join("; ")}`);
  }
  await guardPending(input.guildId, member.id);

  const tz = (await loadGuildSettings(input.guildId))?.guild?.timezone || TZ;
  const hours = minutes / 60;
  const prices = product.price.map((p) => `${Number((p.amount * hours).toFixed(2))} ${p.token}`).join(" or ");
  const params: RoomBookingParams = {
    room: product.slug,
    roomName: product.name,
    start: start.toISOString(),
    end: end.toISOString(),
    title: input.title.trim().slice(0, 100),
    ...(guestEmail ? { guestName, guestEmail } : {}),
  };
  const summary = `Book **${product.name}** on **${whenText(start, end, tz)}** for “${params.title}”` +
    (guestEmail ? `\n👤 For ${guestName} (${guestEmail})` : "") +
    `\n💰 ${prices}${product.price.some((p) => /^eur/i.test(p.token)) ? " (euro prices + VAT)" : ""}: you choose and pay in the next step`;
  return await propose({ ...input, kind: "room_booking", confirmerId: member.id, params, summary });
}

// ── Creating and delivering a request ───────────────────────────────────────

const KIND_LABEL = { mint: "mint", shift_signup: "shift sign-up", room_booking: "room booking" } as const;

function buttons(id: string, kind: PendingRequest["kind"]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}confirm:${id}`).setLabel(kind === "room_booking" ? "Confirm, then pay" : "Confirm").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

export function promptText(
  r: Pick<PendingRequest, "kind" | "confirmerId" | "summary" | "expiresAt" | "requestedBy" | "approval" | "approvers" | "requesterId" | "params">,
): string {
  const expires = `<t:${Math.floor(new Date(r.expiresAt).getTime() / 1000)}:R>`;
  const requester = r.requesterId ?? r.confirmerId;
  if (r.approval === "any_minter") {
    const symbol = (r.params as MintParams).tokenSymbol;
    return `🤖 **Elinor proposes a ${KIND_LABEL[r.kind]}**, requested by <@${requester}>\n\n${r.summary}\n\n` +
      `🔐 Only someone with the right to mint ${symbol} can approve this: ${approverMentions(r.approvers)}\n` +
      `-# Any ${symbol} minter can confirm · <@${requester}> or a minter can cancel · expires ${expires}`;
  }
  const by = requester !== r.confirmerId ? `, requested by <@${requester}>` : "";
  return `🤖 **Elinor proposes a ${KIND_LABEL[r.kind]}** for <@${r.confirmerId}> to confirm${by}\n\n${r.summary}\n\n` +
    `-# Asked by ${r.requestedBy.slice(0, 200)} · only <@${r.confirmerId}> can confirm · expires ${expires}`;
}

async function propose(input: Common & {
  kind: PendingRequest["kind"];
  confirmerId: string;
  requesterId?: string;
  approval?: PendingRequest["approval"];
  approvers?: PendingRequest["approvers"];
  params: PendingRequest["params"];
  summary: string;
}) {
  const request = await createRequest({
    kind: input.kind,
    guildId: input.guildId,
    requestedBy: String(input.requestedBy || "elinor").slice(0, 300),
    confirmerId: input.confirmerId,
    ...(input.requesterId ? { requesterId: input.requesterId } : {}),
    ...(input.approval ? { approval: input.approval } : {}),
    ...(input.approvers ? { approvers: input.approvers } : {}),
    params: input.params,
    summary: input.summary,
  });
  const content = promptText(request);
  const row = buttons(request.id, request.kind);
  const c = requireClient();

  let message: Message | null = null;
  let dm = false;
  let deliveryNote: string | undefined;
  if (input.channelId) {
    // channelId may be a channel or a thread (public or private): threads carry their own guildId.
    const channel = await c.channels.fetch(input.channelId).catch(() => null);
    if (!channel) deliveryNote = `channel ${input.channelId} not found or not visible to the bot`;
    else if (!("guildId" in channel) || channel.guildId !== input.guildId) deliveryNote = `channel ${input.channelId} is not in this server`;
    if (channel?.isThread() && !channel.joined && channel.guildId === input.guildId) {
      // The bot must be in a thread to post there; joining a private thread needs Manage Threads.
      await channel.join().catch((e) => {
        deliveryNote = `couldn't join the thread (${e?.message || e}); give the bot Manage Threads or add it to the thread`;
      });
    }
    if (channel && "guildId" in channel && channel.guildId === input.guildId && channel.isTextBased() && "send" in channel) {
      const allowedMentions = {
        users: [...new Set([request.confirmerId, ...(request.requesterId ? [request.requesterId] : []), ...(request.approvers?.userIds ?? [])])],
        roles: request.approvers?.roleId ? [request.approvers.roleId] : [],
        repliedUser: false,
      };
      const send = (withReply: boolean) =>
        (channel as TextChannel).send({
          content,
          components: [row],
          allowedMentions,
          ...(withReply && input.replyToMessageId ? { reply: { messageReference: input.replyToMessageId, failIfNotExists: false } } : {}),
        });
      // Reply to the request when we know it; fall back to a plain message in the channel.
      message = await send(true).catch(() => send(false)).catch((e) => {
        console.error("[proposals] could not post in channel:", e?.message || e);
        deliveryNote = `couldn't post in ${channel.isThread() ? "the thread" : "the channel"} (${e?.message || e})`;
        return null;
      });
    }
  }
  if (!message && request.approval === "any_minter") {
    await updateRequest(request.guildId, request.id, (r) => {
      r.status = "failed";
      r.decidedAt = new Date().toISOString();
      r.error = "Could not post in the channel, and a minter's approval can't happen by DM";
    });
    throw new Error(`Couldn't post in that channel${deliveryNote ? `: ${deliveryNote}` : ""}. A minter must approve in the channel where the request was made.`);
  }
  if (!message) {
    const user = await c.users.fetch(request.confirmerId).catch(() => null);
    message = user ? await user.send({ content, components: [row] }).catch(() => null) : null;
    dm = !!message;
  }

  if (!message) {
    await updateRequest(request.guildId, request.id, (r) => {
      r.status = "failed";
      r.decidedAt = new Date().toISOString();
      r.error = "Could not deliver the confirmation: no usable channel and DMs are closed";
    });
    await log(request.guildId, `🤖 Elinor proposed a ${KIND_LABEL[request.kind]} for <@${request.confirmerId}> but it couldn't be delivered (${request.id})`);
    throw new Error(`Couldn't reach <@${request.confirmerId}>: pass a channelId the bot can post in, or ask them to open their DMs`);
  }

  const url = dm
    ? `https://discord.com/channels/@me/${message.channelId}/${message.id}`
    : `https://discord.com/channels/${request.guildId}/${message.channelId}/${message.id}`;
  await updateRequest(request.guildId, request.id, (r) => {
    r.message = { channelId: message!.channelId, messageId: message!.id, dm, url };
  });
  await log(
    request.guildId,
    `🤖 Elinor proposed a ${KIND_LABEL[request.kind]} (${request.id}), asked by ${request.requestedBy.slice(0, 120)}, for <@${request.confirmerId}> to confirm ${dm ? "by DM" : `in <#${message.channelId}>`}:\n${request.summary}`,
  );
  return {
    ...publicStatus({ ...request, message: { channelId: message.channelId, messageId: message.id, dm, url } }),
    deliveredBy: dm ? "dm" : "channel",
    ...(dm && input.channelId ? { deliveryNote: `Sent by DM instead of the channel: ${deliveryNote ?? "the channel wasn't usable"}` } : {}),
  };
}

// ── Buttons ─────────────────────────────────────────────────────────────────

async function closePrompt(r: PendingRequest, footer: string) {
  if (!r.message) return;
  try {
    const channel = await requireClient().channels.fetch(r.message.channelId);
    if (channel?.isTextBased()) {
      const msg = await channel.messages.fetch(r.message.messageId);
      await msg.edit({ content: `${r.summary}\n\n${footer}`, components: [], allowedMentions: { parse: [] } });
    }
  } catch (error) {
    console.error("[proposals] could not update the prompt:", error);
  }
}

/** The named confirmer; or, for "any_minter" mint requests, anyone allowed to mint the token right now. */
async function mayConfirm(r: PendingRequest, interaction: ButtonInteraction): Promise<boolean> {
  if (r.approval !== "any_minter") return interaction.user.id === r.confirmerId;
  const guild = await requireClient().guilds.fetch(r.guildId).catch(() => null);
  const member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
  if (!member) return false;
  const settings = await loadGuildSettings(r.guildId);
  const token = getMintableTokens(settings?.tokens ?? []).find((t) => t.symbol === (r.params as MintParams).tokenSymbol);
  return !!token && hasTokenPermission(member, token.minterRoleId);
}

export async function handleProposalButton(interaction: ButtonInteraction): Promise<void> {
  const [action, id] = interaction.customId.slice(BUTTON_PREFIX.length).split(":");
  const guildIds = [...interaction.client.guilds.cache.keys()];
  const r = await getRequest(id, interaction.guildId ? [interaction.guildId, ...guildIds] : guildIds);

  if (!r) {
    await interaction.reply({ content: "⚠️ This request no longer exists.", flags: MessageFlags.Ephemeral });
    return;
  }
  const canConfirm = await mayConfirm(r, interaction);
  const canCancel = canConfirm || interaction.user.id === r.requesterId || interaction.user.id === r.confirmerId;
  if ((action === "confirm" && !canConfirm) || (action === "cancel" && !canCancel)) {
    const who = r.approval === "any_minter"
      ? `Only <@${r.requesterId ?? r.confirmerId}> or a minter (${approverMentions(r.approvers)}) can ${action === "cancel" ? "cancel" : "confirm"} this.`
      : `Only <@${r.confirmerId}> can confirm or cancel this.`;
    const content = r.approval === "any_minter" && action === "confirm" ? `Only a minter (${approverMentions(r.approvers)}) can confirm this.` : who;
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  if (r.status !== "pending" || Date.now() > new Date(r.expiresAt).getTime()) {
    if (r.status === "pending") await transition(r.guildId, r.id, "expired");
    await interaction.update({ content: `${r.summary}\n\n⌛ This request is ${r.status === "pending" ? "expired" : r.status}.`, components: [] });
    return;
  }

  if (action === "cancel") {
    if (!await transition(r.guildId, r.id, "cancelled", interaction.user.id)) return;
    await interaction.update({ content: `${r.summary}\n\n❌ Cancelled by <@${interaction.user.id}>.`, components: [], allowedMentions: { parse: [] } });
    await log(r.guildId, `🤖 ❌ <@${interaction.user.id}> cancelled Elinor's ${KIND_LABEL[r.kind]} request (${r.id})`);
    return;
  }
  if (action !== "confirm") return;

  if (r.kind === "room_booking") return await confirmRoomBooking(interaction, r);

  const claimed = await transition(r.guildId, r.id, "confirmed", interaction.user.id);
  if (!claimed) return;
  await interaction.update({ content: `${r.summary}\n\n⏳ Confirmed by <@${interaction.user.id}>, working on it…`, components: [], allowedMentions: { parse: [] } });

  try {
    const outcome = r.kind === "mint" ? await runMint(r, interaction) : await runShiftSignup(r, interaction);
    await updateRequest(r.guildId, r.id, (x) => {
      x.status = outcome.ok ? "confirmed" : "failed";
      x.result = outcome.result;
      if (!outcome.ok) x.error = outcome.text;
    });
    const header = r.kind === "mint" && outcome.ok
      ? `✅ Minted by <@${interaction.user.id}>${r.requesterId && r.requesterId !== interaction.user.id ? `, requested by <@${r.requesterId}>` : ""}\n`
      : "";
    await interaction.editReply({ content: `${r.summary}\n\n${header}${outcome.text}`, components: [], allowedMentions: { parse: [] } });
    await log(r.guildId, `🤖 ${outcome.ok ? "✅" : "⚠️"} <@${interaction.user.id}> confirmed Elinor's ${KIND_LABEL[r.kind]} request (${r.id}): ${outcome.ok ? "done" : outcome.text.slice(0, 300)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRequest(r.guildId, r.id, (x) => {
      x.status = "failed";
      x.error = message;
    });
    await interaction.editReply({ content: `${r.summary}\n\n❌ Failed: ${message}`, components: [] }).catch(() => {});
    await log(r.guildId, `🤖 ❌ Elinor's ${KIND_LABEL[r.kind]} request (${r.id}) failed after confirmation: ${message.slice(0, 300)}`);
  }
}

type Outcome = { ok: boolean; text: string; result?: unknown };

/** Same as /mint: the clicker must be allowed to mint this token right now. */
async function runMint(r: PendingRequest, interaction: ButtonInteraction): Promise<Outcome> {
  const p = r.params as MintParams;
  const guild = await getGuild(r.guildId);
  const member = await getMember(guild, interaction.user.id, "confirmer");
  const settings = await loadGuildSettings(r.guildId);
  const token = getMintableTokens(settings?.tokens ?? []).find((t) => t.symbol === p.tokenSymbol);
  if (!settings || !token) return { ok: false, text: `❌ ${p.tokenSymbol} is no longer mintable here.` };
  if (!hasTokenPermission(member, token.minterRoleId)) return { ok: false, text: `❌ You no longer have permission to mint ${token.symbol}.` };

  const recipients: Recipient[] = p.recipientIds.map((id) => ({ type: "discord", id, label: `<@${id}>`, accountId: `discord:${id}` }));
  const results = await executeMint({
    client: interaction.client,
    guildSettings: settings,
    token,
    recipients,
    amount: p.amount,
    description: p.description,
    minterId: member.id,
    source: { via: "elinor", messageUrl: r.message?.url },
  });
  const ok = results.some((x) => x.success);
  return {
    ok,
    text: formatMintResults(results, token, p.amount, p.description),
    result: results.map((x) => ({ userId: x.recipient.id, success: x.success, txHash: x.hash ?? null, error: x.error ?? null })),
  };
}

/** Same as /shifts: the member signs themselves up. */
async function runShiftSignup(r: PendingRequest, interaction: ButtonInteraction): Promise<Outcome> {
  const p = r.params as ShiftSignupParams;
  const guild = await getGuild(r.guildId);
  const gm = await getMember(guild, interaction.user.id, "member");
  const settings = await loadShiftsSettings(r.guildId);
  const start = new Date(p.start), end = new Date(p.end);
  if (end.getTime() < Date.now()) return { ok: false, text: "❌ This shift is already over." };

  if (p.email) {
    await saveUser(r.guildId, { discordUserId: gm.id, username: gm.user.username, displayName: nameOf(gm), email: p.email });
  }
  const email = p.email ?? getUserEmail(r.guildId, gm.id);
  const member = { id: gm.id, username: gm.user.username, displayName: nameOf(gm), avatar: gm.displayAvatarURL({ size: 256, extension: "png" }) };
  const result = await signUpForShift({ guildId: r.guildId, guildName: guild.name, settings, member, email, start, end });
  if (!result.ok) {
    return { ok: false, text: result.reason === "full" ? "⚠️ This shift is full now." : "⚠️ You're already signed up for this shift." };
  }
  const notified = await notifyShiftSignup({ settings, member, email, start, end, calendarEventId: result.event.id });
  await logShiftAction(`📋 <@${gm.id}> signed up for a shift on **${whenText(start, end, settings.timezone)}** (proposed by Elinor)`);
  const mail = notified.emailed ? `\n📨 Confirmation email sent to ${email}.` : email ? `\n⚠️ The confirmation email could not be sent.` : "";
  return {
    ok: true,
    text: `✅ You're on shift: **${whenText(start, end, settings.timezone)}**. Thank you for taking care of the hub! 🙏${mail}`,
    result: { calendarEventId: result.event.id, emailed: notified.emailed, nostrEventId: result.nostrEventId },
  };
}

/** The member continues in the regular /book flow (payment choice, balance check, booking). */
async function confirmRoomBooking(interaction: ButtonInteraction, r: PendingRequest) {
  const p = r.params as RoomBookingParams;
  const claimed = await transition(r.guildId, r.id, "handed_off", interaction.user.id);
  if (!claimed) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await updateRequest(r.guildId, r.id, (x) => {
    x.result = { note: "Continued in /book at the payment step; the booking is made when the member confirms the payment there." };
  });
  await closePrompt(r, `➡️ Confirmed by <@${interaction.user.id}>: continuing in /book to pay.`);
  await startPrefilledBooking(interaction, interaction.user.id, r.guildId, {
    productSlug: p.room,
    start: new Date(p.start),
    end: new Date(p.end),
    name: p.title,
    guest: p.guestEmail && p.guestName ? { name: p.guestName, email: p.guestEmail } : undefined,
    timezone: (await loadGuildSettings(r.guildId))?.guild?.timezone || TZ,
  });
  await log(r.guildId, `🤖 ➡️ <@${interaction.user.id}> confirmed Elinor's room booking request (${r.id}) and continues in /book to pay`);
}

// ── Expiry ──────────────────────────────────────────────────────────────────

export async function expireDueRequests(now = new Date()) {
  if (!client) return;
  for (const r of await findExpired([...client.guilds.cache.keys()], now)) {
    if (!await transition(r.guildId, r.id, "expired", undefined, now)) continue;
    await closePrompt(r, "⌛ Expired: nobody confirmed within 24 hours.");
    await log(r.guildId, `🤖 ⌛ Elinor's ${KIND_LABEL[r.kind]} request (${r.id}) for <@${r.confirmerId}> expired`);
  }
}

export function startProposalExpiry(c: Client, everyMs = 5 * 60 * 1000) {
  setProposalsClient(c);
  expireDueRequests().catch((e) => console.error("[proposals] expiry failed:", e));
  return setInterval(() => expireDueRequests().catch((e) => console.error("[proposals] expiry failed:", e)), everyMs);
}
