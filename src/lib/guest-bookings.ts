/**
 * Bookings made for a guest (/book → "For a guest..."), remembered so the guest can be told
 * when the booking is changed or cancelled (/bookings edit or cancel, /cancel).
 *
 * Kept in the bot's data volume, DATA_DIR/<guild>/guest-bookings.jsonl (append-only, the
 * last line per calendar event wins), never in the calendar event: the room calendars are
 * public and the record holds the guest's email.
 */

import { getEnv } from "./utils.ts";
import { fetchRoomImage, sendBookingConfirmation } from "./booking-email.ts";
import { bookingReason, buildDoorLink } from "./door-link.ts";

export interface GuestBookingRecord {
  calendarId: string;
  eventId: string;
  /** Calendar identity used in the guest's .ics; stays the same across changes. */
  uid: string;
  sequence: number;
  productSlug: string;
  roomName: string;
  guestName: string;
  guestEmail: string;
  bookerId: string;
  bookerName: string;
  bookerEmail?: string;
  eventName: string;
  start: string;
  end: string;
  eventUrl?: string;
  tokenSymbol: string;
  priceTotal: number;
  status: "active" | "cancelled";
  updatedAt: string;
}

const fileFor = (guildId: string) => `${getEnv("DATA_DIR") || "/data"}/${guildId}/guest-bookings.jsonl`;
const keyOf = (calendarId: string, eventId: string) => `${calendarId}|${eventId}`;

async function loadAll(guildId: string): Promise<Map<string, GuestBookingRecord>> {
  const out = new Map<string, GuestBookingRecord>();
  let content = "";
  try {
    content = await Deno.readTextFile(fileFor(guildId));
  } catch {
    return out;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as GuestBookingRecord & { supersedes?: string };
      if (r.supersedes) out.delete(r.supersedes);
      out.set(keyOf(r.calendarId, r.eventId), r);
    } catch { /* skip malformed */ }
  }
  return out;
}

async function append(guildId: string, record: GuestBookingRecord & { supersedes?: string }): Promise<void> {
  const path = fileFor(guildId);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(record) + "\n", { append: true });
}

export async function recordGuestBooking(guildId: string, record: Omit<GuestBookingRecord, "updatedAt">): Promise<void> {
  await append(guildId, { ...record, updatedAt: new Date().toISOString() });
}

export async function findGuestBooking(guildId: string, calendarId: string, eventId: string): Promise<GuestBookingRecord | undefined> {
  const r = (await loadAll(guildId)).get(keyOf(calendarId, eventId));
  return r && r.status === "active" ? r : undefined;
}

function emailBase(r: GuestBookingRecord) {
  return {
    guestName: r.guestName,
    guestEmail: r.guestEmail,
    bookerName: r.bookerName,
    bookerEmail: r.bookerEmail,
    eventName: r.eventName,
    bookingId: r.uid,
    uids: [r.uid],
    tokenSymbol: r.tokenSymbol,
  };
}

/**
 * The booking behind (calendarId, eventId) was changed: tell the guest (cc the booker) with the
 * new details, a new door link and an updated .ics. Returns a line for the person who changed it,
 * or "" when the booking was not made for a guest.
 */
export async function notifyGuestBookingChanged(
  guildId: string,
  calendarId: string,
  eventId: string,
  change: { calendarId: string; eventId: string; productSlug: string; roomName: string; start: Date; end: Date; eventUrl?: string; priceTotal: number },
): Promise<string> {
  const r = await findGuestBooking(guildId, calendarId, eventId);
  if (!r) return "";
  const updated: GuestBookingRecord = {
    ...r,
    calendarId: change.calendarId,
    eventId: change.eventId,
    productSlug: change.productSlug,
    roomName: change.roomName,
    start: change.start.toISOString(),
    end: change.end.toISOString(),
    eventUrl: change.eventUrl,
    priceTotal: change.priceTotal,
    sequence: r.sequence + 1,
    updatedAt: new Date().toISOString(),
  };
  await append(guildId, { ...updated, supersedes: keyOf(calendarId, eventId) });
  try {
    const doorLink = await buildDoorLink({
      name: r.guestName,
      host: r.bookerName,
      reason: bookingReason(change.roomName, change.start, change.end),
      start: change.start,
      end: change.end,
    }).catch(() => null);
    await sendBookingConfirmation({
      ...emailBase(updated),
      kind: "updated",
      roomName: change.roomName,
      roomImageUrl: await fetchRoomImage(change.productSlug),
      occurrences: [{ start: change.start, end: change.end }],
      previous: { roomName: r.roomName, occurrences: [{ start: new Date(r.start), end: new Date(r.end) }] },
      priceTotal: change.priceTotal,
      eventUrl: change.eventUrl,
      sequence: updated.sequence,
      doorLinks: [doorLink],
    });
    return `📨 ${r.guestName} was emailed the new details${r.bookerEmail ? " (you are in cc)" : ""}.`;
  } catch (error: any) {
    console.error("[guest-bookings] change email failed:", error?.message || error);
    return `⚠️ Could not email ${r.guestName} about the change (${String(error?.message || error).slice(0, 120)}). Please let them know.`;
  }
}

/** The booking behind (calendarId, eventId) was cancelled: tell the guest (cc the booker) with a cancelling .ics. */
export async function notifyGuestBookingCancelled(guildId: string, calendarId: string, eventId: string): Promise<string> {
  const r = await findGuestBooking(guildId, calendarId, eventId);
  if (!r) return "";
  const cancelled: GuestBookingRecord = { ...r, status: "cancelled", sequence: r.sequence + 1, updatedAt: new Date().toISOString() };
  await append(guildId, cancelled);
  try {
    await sendBookingConfirmation({
      ...emailBase(cancelled),
      kind: "cancelled",
      roomName: r.roomName,
      occurrences: [{ start: new Date(r.start), end: new Date(r.end) }],
      priceTotal: r.priceTotal,
      eventUrl: r.eventUrl,
      sequence: cancelled.sequence,
    });
    return `📨 ${r.guestName} was emailed that the booking is cancelled${r.bookerEmail ? " (you are in cc)" : ""}.`;
  } catch (error: any) {
    console.error("[guest-bookings] cancellation email failed:", error?.message || error);
    return `⚠️ Could not email ${r.guestName} about the cancellation (${String(error?.message || error).slice(0, 120)}). Please let them know.`;
  }
}
