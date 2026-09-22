/**
 * Keeps the shifts calendar and the community relays in sync.
 *
 * The relays are the record (see shifts-nostr.ts); the Google Calendar is
 * what every /shifts flow (sign-up, cancel, reward) reads, and what members
 * get invited to. This sync makes the calendar follow the relays and fills
 * the relays from the calendar where the relays know nothing yet:
 *
 *   relay says accepted, calendar has no sign-up  → add the sign-up line (and the event if needed)
 *   relay says declined, calendar has the sign-up → add the cancellation line
 *   calendar has a sign-up, relay has no RSVP     → publish an accepted RSVP for the member
 *
 * Runs a full reconciliation every few minutes and right after any RSVP
 * arrives live on a relay, for the standard slots of the next 28 days.
 * A shift occurrence (kind 31923) is published only once a slot has its
 * first sign-up, from either app; empty slots publish nothing.
 * Custom-time shifts have no slot on the relays and are left alone.
 */

import type { Client } from "discord.js";
import { GoogleCalendarClient, type CalendarEvent } from "./googlecalendar.ts";
import { getUser, getUserEmail, saveUser } from "./user-emails.ts";
import {
  KIND_RSVP,
  type DiscordMember,
  type NostrSignup,
  type ShiftSlot,
  ShiftsNostr,
  type ShiftsNostrSettings,
  dayString,
  slotCode,
} from "./shifts-nostr.ts";
import {
  appendToDescription,
  buildShiftSignupUpsert,
  createDateTime,
  formatAuditTimestamp,
  formatTime,
  parseShiftSignups,
} from "../commands/shifts.ts";

export interface ShiftsSyncSettings {
  calendarId: string;
  description: string;
  maxSignupsPerSlot: number;
  slots: ShiftSlot[];
  timezone: string;
  nostr?: ShiftsNostrSettings;
}

const HORIZON_DAYS = 28;
const FULL_SYNC_EVERY_MS = 5 * 60 * 1000;
const LIVE_DEBOUNCE_MS = 1500;

interface Runner {
  stop: () => void;
}

const runners = new Map<string, Runner>();

export function startShiftsNostrSync(guildId: string, guildName: string, settings: ShiftsSyncSettings, client: Client): void {
  if (runners.has(guildId)) return;
  const nostr = ShiftsNostr.forGuild({ guildId, name: guildName }, settings.nostr);
  if (!nostr) {
    console.log("[shifts-sync] Nostr disabled or NOSTR_NSEC missing; shifts stay calendar-only");
    return;
  }
  console.log(`[shifts-sync] Starting: bot ${nostr.npub}, coordinator ${nostr.coordinator === nostr.botPubkey ? "this bot" : nostr.coordinator}, relays ${nostr.relays.join(", ")}`);

  let running = false;
  let queued = false;
  const run = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await reconcile(nostr, settings, guildId, client);
    } catch (error) {
      console.error("[shifts-sync] reconcile failed:", error);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        setTimeout(run, LIVE_DEBOUNCE_MS);
      }
    }
  };

  const first = setTimeout(run, 20_000);
  const interval = setInterval(run, FULL_SYNC_EVERY_MS);
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Math.floor(Date.now() / 1000);
  const unsubscribe = nostr.subscribe({ kinds: [KIND_RSVP], "#i": [`discord:${guildId}`], since: startedAt }, () => {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(run, LIVE_DEBOUNCE_MS);
  });

  runners.set(guildId, {
    stop: () => {
      clearTimeout(first);
      clearInterval(interval);
      if (liveTimer) clearTimeout(liveTimer);
      unsubscribe();
    },
  });
}

export function stopShiftsNostrSync(guildId: string): void {
  runners.get(guildId)?.stop();
  runners.delete(guildId);
}

// ── one pass ───────────────────────────────────────────────────────────────

function upcomingDays(settings: ShiftsSyncSettings, count = HORIZON_DAYS): { day: string; date: Date }[] {
  const out: { day: string; date: Date }[] = [];
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const date = new Date(base);
    date.setDate(base.getDate() + i);
    out.push({ day: dayString(date, settings.timezone), date });
  }
  return out;
}

function findSlotEvent(events: CalendarEvent[], date: Date, slot: ShiftSlot, timezone: string): CalendarEvent | undefined {
  const start = createDateTime(date, slot.start, timezone).getTime();
  const end = createDateTime(date, slot.end, timezone).getTime();
  return events.find((event) => {
    if (!event.start?.dateTime || !event.end?.dateTime) return false;
    return Math.abs(new Date(event.start.dateTime).getTime() - start) < 60_000 && Math.abs(new Date(event.end.dateTime).getTime() - end) < 60_000;
  });
}

async function resolveMember(client: Client, guildId: string, discordId: string, fallbackName?: string): Promise<DiscordMember | null> {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordId);
    const resolved: DiscordMember = {
      id: member.id,
      username: member.user.username,
      displayName: member.displayName || member.user.globalName || member.user.username,
      avatar: member.user.displayAvatarURL({ size: 256, extension: "png" }),
    };
    saveUser(guildId, { discordUserId: resolved.id, username: resolved.username, displayName: resolved.displayName, email: getUserEmail(guildId, resolved.id) }).catch(() => {});
    return resolved;
  } catch {
    const known = getUser(guildId, discordId);
    if (known) return { id: discordId, username: known.username, displayName: known.displayName || known.username };
    if (fallbackName) return { id: discordId, username: fallbackName.replace(/\s+/g, "-").toLowerCase(), displayName: fallbackName };
    return null;
  }
}

export async function reconcile(nostr: ShiftsNostr, settings: ShiftsSyncSettings, guildId: string, client: Client): Promise<{ mirrored: number; cancelled: number; published: number }> {
  const days = upcomingDays(settings);
  const calendar = new GoogleCalendarClient();
  const rangeStart = new Date(days[0].date);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(days[days.length - 1].date);
  rangeEnd.setHours(23, 59, 59, 999);

  const [events, signups] = await Promise.all([
    calendar.listEvents(settings.calendarId, rangeStart, rangeEnd),
    nostr.loadSignups(days.map((d) => d.day), settings.slots),
  ]);
  const byDaySlot = new Map<string, NostrSignup[]>();
  for (const signup of signups) {
    const key = `${signup.day}:${signup.slotCode}`;
    byDaySlot.set(key, [...(byDaySlot.get(key) ?? []), signup]);
  }

  const counters = { mirrored: 0, cancelled: 0, published: 0 };
  const now = Date.now();
  const title = (slot: ShiftSlot) => `Caretaking shift ${slot.start}–${slot.end}`;
  const publishOptions = (slot: ShiftSlot) => ({ capacity: settings.maxSignupsPerSlot, title: title(slot), communityDescription: settings.description });

  for (const { day, date } of days) {
    for (const slot of settings.slots) {
      if (createDateTime(date, slot.end, settings.timezone).getTime() < now) continue; // already over
      const fromRelay = byDaySlot.get(`${day}:${slotCode(slot)}`) ?? [];
      let event = findSlotEvent(events, date, slot, settings.timezone);
      const inCalendar = parseShiftSignups(event?.description || "");
      const relayById = new Map(fromRelay.filter((s) => s.discordId).map((s) => [s.discordId!, s]));

      // 1. Relay → calendar: accepted RSVPs the calendar does not have yet.
      const toMirror: DiscordMember[] = [];
      for (const signup of fromRelay) {
        if (signup.status !== "accepted" || !signup.discordId) continue;
        if (inCalendar.some((s) => s.discordUserId === signup.discordId)) continue;
        const member = await resolveMember(client, guildId, signup.discordId, signup.name);
        if (member) toMirror.push(member);
      }
      if (toMirror.length > 0) {
        const upsert = buildShiftSignupUpsert({
          existingEvent: event,
          selectedDate: date,
          selectedSlot: slot,
          timezone: settings.timezone,
          participants: toMirror.map((m) => ({ discordUserId: m.id, username: m.username, email: getUserEmail(guildId, m.id) })),
          timestamp: formatAuditTimestamp(),
        });
        // Say where it came from so the audit trail stays honest.
        upsert.payload.description = upsert.payload.description.replace(/ signed up \(discord:(\d+)\)$/gm, " signed up (discord:$1) via nostr");
        if (upsert.action === "update" && event?.id) {
          await calendar.updateEvent(settings.calendarId, event.id, upsert.payload);
          event = { ...event, ...upsert.payload };
        } else {
          event = await calendar.createEventNoConflictCheck(settings.calendarId, upsert.payload);
        }
        counters.mirrored += toMirror.length;
        console.log(`[shifts-sync] mirrored ${toMirror.map((m) => "@" + m.username).join(", ")} into the calendar for ${day} ${formatTime(slot.start)}`);
      }

      // 2. Relay → calendar: declined RSVPs for people the calendar still lists.
      const stillListed = parseShiftSignups(event?.description || "");
      const toCancel = stillListed.filter((s) => relayById.get(s.discordUserId)?.status === "declined");
      if (toCancel.length > 0 && event?.id) {
        let desc = event.description || "";
        for (const s of toCancel) {
          const user = getUser(guildId, s.discordUserId);
          const name = user ? `${user.displayName} <@${user.username}>` : `<@${s.username}>`;
          desc = appendToDescription(desc, `${formatAuditTimestamp()}: ${name} cancelled (via nostr)`);
        }
        const remaining = stillListed.length - toCancel.length;
        const payload: Record<string, unknown> = { description: desc };
        if (remaining === 0 && event.summary && !event.summary.startsWith("[Cancelled]")) payload.summary = `[Cancelled] ${event.summary}`;
        await calendar.updateEvent(settings.calendarId, event.id, payload);
        event = { ...event, ...payload } as CalendarEvent;
        counters.cancelled += toCancel.length;
        console.log(`[shifts-sync] cancelled ${toCancel.map((s) => "@" + s.username).join(", ")} in the calendar for ${day} ${formatTime(slot.start)}`);
      }

      // 3. Calendar → relay: sign-ups the relays have never heard of.
      for (const s of parseShiftSignups(event?.description || "")) {
        if (!s.discordUserId || relayById.has(s.discordUserId)) continue;
        const member = await resolveMember(client, guildId, s.discordUserId, s.username);
        if (!member) continue;
        try {
          await nostr.publishRsvp("signup", member, day, slot, publishOptions(slot));
          counters.published++;
        } catch (error) {
          console.error(`[shifts-sync] could not publish RSVP for @${member.username} ${day} ${slotCode(slot)}:`, (error as Error).message);
        }
      }

      // 4. A slot with a sign-up gets its occurrence (published once, on the first sign-up, like the website did).
      const taken = fromRelay.some((s) => s.status === "accepted") || parseShiftSignups(event?.description || "").length > 0;
      if (taken) {
        try {
          await nostr.ensureCommunityDefinition(settings.description);
          await nostr.ensureShiftOccurrence(day, slot, settings.maxSignupsPerSlot, title(slot));
        } catch (error) {
          console.error(`[shifts-sync] could not publish occurrence ${day} ${slotCode(slot)}:`, (error as Error).message);
        }
      }
    }
  }


  if (counters.mirrored || counters.cancelled || counters.published) console.log("[shifts-sync] done:", counters);
  return counters;
}
