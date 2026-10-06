/**
 * Shifts endpoints for the community tablet (commonshub.brussels/tablet) and the cancel page
 * (commonshub.brussels/shifts/cancel). Bearer API_KEY auth is checked by the router in api.ts.
 *
 *   GET  /api/shifts?guildId=&from=&to=
 *   GET  /api/members?guildId=&q=&limit=
 *   POST /api/shifts/signup          { guildId, discordUserId, start, end, eventTitle?, source? }
 *   POST /api/shifts/cancel          { token }
 *   POST /api/shifts/email-preview   { guildId, discordUserId?, email?, start, end, eventTitle?, send? }
 */
import type { Client, Guild, GuildMember } from "discord.js";
import { GoogleCalendarClient } from "./googlecalendar.ts";
import { getUser, getUserEmail } from "./user-emails.ts";
import { verifyCancelToken } from "./shift-cancel-token.ts";
import { buildShiftCancelledDm, buildShiftEmail, hhmm, longDay, sendShiftConfirmation } from "./shift-email.ts";
import { Discord } from "./discord.ts";
import {
  type CalendarEvent,
  cancelShift,
  isCancelledShiftEvent,
  loadShiftsSettings,
  notifyShiftSignup,
  parseShiftSignups,
  type ShiftMember,
  shiftLogWhen,
  type ShiftsSettings,
  signUpForShift,
} from "../commands/shifts.ts";

const SHIFTS_LOG_CHANNEL_ID = "1484493597901455370";
const MAX_SHIFT_HOURS = 12;
const MAX_RANGE_DAYS = 62;

type Json = Record<string, unknown> | unknown[];
const json = (data: Json, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const fail = (message: string, status = 400, extra: Record<string, unknown> = {}) => json({ error: message, ...extra }, status);

export type MemberDto = { id: string; username: string; displayName: string; avatar: string };

function memberDto(m: GuildMember): MemberDto {
  return {
    id: m.id,
    username: m.user.username,
    displayName: m.displayName || m.user.globalName || m.user.username,
    avatar: m.displayAvatarURL({ size: 128, extension: "png" }),
  };
}

function shiftMember(m: GuildMember): ShiftMember {
  const d = memberDto(m);
  return { id: d.id, username: d.username, displayName: d.displayName, avatar: d.avatar };
}

async function log(message: string) {
  try {
    await Discord.getInstance()?.postToDiscordChannel(message, SHIFTS_LOG_CHANNEL_ID);
  } catch (err) {
    console.error("[shifts-api] could not log to #shifts:", err);
  }
}

// ── Member search ───────────────────────────────────────────────────────────

/** Lower-case, accents removed: "Marlène" → "marlene". */
export function normalizeName(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/**
 * Rank candidates for a query: 0 = a name starts with q, 1 = a word in a name starts with q,
 * 2 = a name contains q, null = no match. Names: display name, global name, username.
 */
export function matchRank(names: (string | null | undefined)[], q: string): number | null {
  const query = normalizeName(q);
  if (!query) return 0;
  const ns = names.filter((n): n is string => !!n).map(normalizeName);
  if (ns.some((n) => n.startsWith(query))) return 0;
  if (ns.some((n) => n.split(/[\s._\-]+/).some((w) => w.startsWith(query)))) return 1;
  if (ns.some((n) => n.includes(query))) return 2;
  return null;
}

export function searchMembers(
  members: GuildMember[],
  q: string,
  limit: number,
  knownSince: (id: string) => string | undefined,
): MemberDto[] {
  const humans = members.filter((m) => !m.user.bot);
  if (!q.trim()) {
    // No query: people the bot has seen (sign-ups, bookings…) first, most recent first, then by name.
    return humans
      .map((m) => ({ m, seen: knownSince(m.id) ?? "" }))
      .sort((a, b) => b.seen.localeCompare(a.seen) || memberDto(a.m).displayName.localeCompare(memberDto(b.m).displayName))
      .slice(0, limit)
      .map(({ m }) => memberDto(m));
  }
  return humans
    .map((m) => ({ m, rank: matchRank([m.displayName, m.user.globalName, m.user.username], q) }))
    .filter((x): x is { m: GuildMember; rank: number } => x.rank !== null)
    .sort((a, b) => a.rank - b.rank || memberDto(a.m).displayName.localeCompare(memberDto(b.m).displayName))
    .slice(0, limit)
    .map(({ m }) => memberDto(m));
}

// Fetching every member is slow; refresh at most every 10 minutes.
const memberCache = new Map<string, { at: number; members: GuildMember[] }>();
async function guildMembers(guild: Guild): Promise<GuildMember[]> {
  const cached = memberCache.get(guild.id);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.members;
  const members = [...(await guild.members.fetch()).values()];
  memberCache.set(guild.id, { at: Date.now(), members });
  return members;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function context(client: Client | null, guildId: string | null | undefined) {
  if (!guildId) return { error: fail("guildId is required") };
  if (!client) return { error: fail("Discord client not ready", 503) };
  const settings = await loadShiftsSettings(guildId);
  if (!settings) return { error: fail("Shifts are not configured for this guild", 404) };
  let guild: Guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch {
    return { error: fail("Unknown guild", 404) };
  }
  return { settings, guild };
}

export type ShiftDto = {
  id: string;
  start: string;
  end: string;
  summary: string;
  signups: { discordUserId: string; username: string; displayName: string; avatar: string | null }[];
};

async function shiftDto(event: CalendarEvent, guild: Guild, guildId: string): Promise<ShiftDto> {
  const signups = await Promise.all(parseShiftSignups(event.description || "").map(async (s) => {
    const m = s.discordUserId ? await guild.members.fetch(s.discordUserId).catch(() => null) : null;
    if (m) {
      const d = memberDto(m);
      return { discordUserId: d.id, username: d.username, displayName: d.displayName, avatar: d.avatar as string | null };
    }
    const known = s.discordUserId ? getUser(guildId, s.discordUserId) : undefined;
    return { discordUserId: s.discordUserId, username: s.username, displayName: known?.displayName || s.username, avatar: null as string | null };
  }));
  return {
    id: event.id!,
    start: new Date(event.start.dateTime).toISOString(),
    end: new Date(event.end.dateTime).toISOString(),
    summary: event.summary || "",
    signups,
  };
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function listShifts(url: URL, client: Client | null): Promise<Response> {
  const ctx = await context(client, url.searchParams.get("guildId"));
  if ("error" in ctx) return ctx.error!;
  const from = parseDate(url.searchParams.get("from")) ?? new Date();
  const to = parseDate(url.searchParams.get("to")) ?? new Date(from.getTime() + 7 * 86400000);
  if (to <= from) return fail("`to` must be after `from`");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86400000) return fail(`The range can't exceed ${MAX_RANGE_DAYS} days`);

  const events = (await new GoogleCalendarClient().listEvents(ctx.settings.calendarId, from, to)) as CalendarEvent[];
  const shifts = await Promise.all(
    events.filter((e) => e.id && e.start?.dateTime && !isCancelledShiftEvent(e)).map((e) => shiftDto(e, ctx.guild, ctx.guild.id)),
  );
  return json({
    shifts,
    maxSignupsPerSlot: ctx.settings.maxSignupsPerSlot,
    rewardAmountPerHour: ctx.settings.rewardAmountPerHour,
    rewardTokenSymbol: ctx.settings.rewardTokenSymbol,
  });
}

async function listMembers(url: URL, client: Client | null): Promise<Response> {
  const guildId = url.searchParams.get("guildId");
  if (!guildId) return fail("guildId is required");
  if (!client) return fail("Discord client not ready", 503);
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return fail("Unknown guild", 404);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const members = await guildMembers(guild);
  return json(searchMembers(members, url.searchParams.get("q") || "", limit, (id) => getUser(guildId, id)?.updatedAt));
}

async function signup(req: Request, client: Client | null): Promise<Response> {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail("Invalid JSON body");
  const ctx = await context(client, body.guildId as string);
  if ("error" in ctx) return ctx.error!;
  const { settings, guild } = ctx;

  const start = parseDate(body.start), end = parseDate(body.end);
  if (!start || !end) return fail("start and end must be ISO dates");
  if (end <= start) return fail("end must be after start");
  if (end.getTime() - start.getTime() > MAX_SHIFT_HOURS * 3600000) return fail(`A shift can't be longer than ${MAX_SHIFT_HOURS} hours`);
  if (end.getTime() < Date.now()) return fail("This shift is already over");
  const eventTitle = typeof body.eventTitle === "string" && body.eventTitle.trim() ? body.eventTitle.trim().slice(0, 200) : undefined;
  const via = body.source === "tablet" || body.source === undefined ? "tablet" : "discord";

  const discordUserId = String(body.discordUserId || "");
  const gm = /^\d+$/.test(discordUserId) ? await guild.members.fetch(discordUserId).catch(() => null) : null;
  if (!gm || gm.user.bot) return fail("Unknown member", 404, { code: "unknown_member" });
  const member = shiftMember(gm);
  const email = getUserEmail(guild.id, member.id);

  const result = await signUpForShift({ guildId: guild.id, guildName: guild.name, settings, member, email, start, end, via, eventTitle });
  if (!result.ok) {
    const shift = await shiftDto(result.event, guild, guild.id);
    return result.reason === "full"
      ? fail("This shift is full", 409, { code: "full", shift })
      : fail(`${member.displayName} is already signed up for this shift`, 409, { code: "already_signed_up", shift });
  }

  const notified = await notifyShiftSignup({
    guildId: guild.id,
    settings,
    member,
    email,
    start,
    end,
    calendarEventId: result.event.id,
    eventTitle,
    via,
    dm: (text) => gm.send(text),
  });

  await log(
    `📋 <@${member.id}> signed up${via === "tablet" ? " via the tablet" : ""} for ${shiftLogWhen(start, end, settings.timezone)}${eventTitle ? ` to steward ${eventTitle}` : ""}`,
  );

  return json({
    ok: true,
    shift: await shiftDto(result.event, guild, guild.id),
    cancelUrl: notified.cancelUrl ?? null,
    emailed: notified.emailed,
    dmSent: notified.dmSent,
  });
}

async function cancel(req: Request, client: Client | null): Promise<Response> {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const verified = await verifyCancelToken(String(body?.token || ""));
  if (!verified.ok) {
    return verified.reason === "expired"
      ? fail("This cancel link has expired: the shift is over", 410, { code: "expired" })
      : fail("Invalid cancel link", 400, { code: "invalid_token" });
  }
  const { calendarEventId, discordUserId } = verified.claims;
  if (!client) return fail("Discord client not ready", 503);

  // The token doesn't carry the guild: find the guild whose shifts calendar has this event.
  for (const guild of client.guilds.cache.values()) {
    const settings = await loadShiftsSettings(guild.id);
    if (!settings) continue;
    const event = await new GoogleCalendarClient().getEvent(settings.calendarId, calendarEventId) as CalendarEvent | null;
    if (!event) continue;
    return await cancelInGuild(guild, settings, event, discordUserId);
  }
  return fail("Shift not found", 404, { code: "not_found" });
}

async function cancelInGuild(guild: Guild, settings: ShiftsSettings, event: CalendarEvent, discordUserId: string): Promise<Response> {
  const gm = await guild.members.fetch(discordUserId).catch(() => null);
  const known = getUser(guild.id, discordUserId);
  const signup = parseShiftSignups(event.description || "").find((s) => s.discordUserId === discordUserId);
  const displayName = gm ? memberDto(gm).displayName : known?.displayName || signup?.username || "member";
  const start = new Date(event.start.dateTime), end = new Date(event.end.dateTime);
  const shift = { start: start.toISOString(), end: end.toISOString(), summary: event.summary || "" };

  if (!signup) return json({ ok: true, alreadyCancelled: true, shift, member: { displayName } });

  await cancelShift(event, discordUserId, guild.id, settings, gm ? shiftMember(gm) : undefined, guild.name);
  if (gm) await gm.send(buildShiftCancelledDm(start, end, settings.timezone)).catch(() => {});
  await log(`❌ <@${discordUserId}> cancelled their shift on ${shiftLogWhen(start, end, settings.timezone)} (cancel link)`);
  return json({ ok: true, alreadyCancelled: false, shift, member: { displayName } });
}

/** Render the shift confirmation email for a sample shift, and send it when `send` is true. */
async function emailPreview(req: Request, client: Client | null): Promise<Response> {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail("Invalid JSON body");
  const ctx = await context(client, body.guildId as string);
  if ("error" in ctx) return ctx.error!;
  const start = parseDate(body.start), end = parseDate(body.end);
  if (!start || !end || end <= start) return fail("start and end must be ISO dates, end after start");
  const gm = body.discordUserId ? await ctx.guild.members.fetch(String(body.discordUserId)).catch(() => null) : null;
  const email = (typeof body.email === "string" && body.email) || (gm ? getUserEmail(ctx.guild.id, gm.id) : undefined);
  const hours = (end.getTime() - start.getTime()) / 3600000;
  const details = {
    memberName: gm ? memberDto(gm).displayName : String(body.name || "there"),
    email,
    start,
    end,
    timezone: ctx.settings.timezone,
    eventTitle: typeof body.eventTitle === "string" ? body.eventTitle : undefined,
    reward: { amount: Number((hours * ctx.settings.rewardAmountPerHour).toFixed(2)), symbol: ctx.settings.rewardTokenSymbol },
    doorLink: "https://door.commonshub.brussels/open?sample=1",
    cancelUrl: "https://commonshub.brussels/shifts/cancel?t=sample",
    via: body.source === "tablet" ? "tablet" as const : "discord" as const,
  };
  const rendered = buildShiftEmail(details);
  if (body.send === true) {
    if (!email) return fail("No email: pass `email`, or a discordUserId whose email the bot knows", 400);
    const sent = await sendShiftConfirmation(details);
    return json({ ok: true, sentTo: email, id: sent.id, subject: rendered.subject });
  }
  return json({ ok: true, subject: rendered.subject, html: rendered.html, text: rendered.text, wouldSendTo: email ?? null });
}

/** Route a shifts/members request, or return null when the path isn't one of ours. */
export async function handleShiftsApi(req: Request, url: URL, client: Client | null): Promise<Response | null> {
  const { pathname: path } = url;
  if (path === "/api/shifts" && req.method === "GET") return await listShifts(url, client);
  if (path === "/api/members" && req.method === "GET") return await listMembers(url, client);
  if (path === "/api/shifts/signup" && req.method === "POST") return await signup(req, client);
  if (path === "/api/shifts/cancel" && req.method === "POST") return await cancel(req, client);
  if (path === "/api/shifts/email-preview" && req.method === "POST") return await emailPreview(req, client);
  return null;
}

// Re-exported for tests.
export { hhmm, longDay };
