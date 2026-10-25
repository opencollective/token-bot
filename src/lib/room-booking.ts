/**
 * A room booked and paid with tokens, without a Discord interaction: what the website's "Book a
 * room" does (src/lib/website-api.ts). Same rules, report, calendar event, annotation and emails as
 * a confirmed /book token booking (src/commands/book.ts processBooking), so both read the same in
 * the calendar, #transactions and the guest's inbox.
 *
 * A booking for a guest without an email address is allowed here: no email, and the member gets a
 * pass link to share instead (commonshub.brussels/pass#…&pass=room&room=<name>).
 */
import { Client, TextChannel } from "discord.js";
import { buildDoorLink, bookingReason } from "./door-link.ts";
import { GoogleCalendarClient } from "./googlecalendar.ts";
import { fetchRoomImage, ratesFromPrices, sendBookingConfirmation } from "./booking-email.ts";
import { recordGuestBooking } from "./guest-bookings.ts";
import { calendarPaidLine, publishBookingAnnotation } from "./booking-annotations.ts";
import { reportTransaction } from "./tx-reports.ts";
import { txUriFor } from "./tx-categories.ts";
import { calendarTermsLine, isEuroToken } from "./token-terms.ts";
import { checkBookableFrom, localHHMM, minutesOf } from "./room-rules.ts";
import { invalidateRoomEventsCache } from "./room-events-cache.ts";
import { burnFromMember } from "./shop.ts";
import { txUrlFor } from "./mint.ts";
import { PASS_PAGE_URL } from "./guest-pass.ts";
import { getEnv } from "./utils.ts";
import type { GuildSettings, Product, Token } from "../types.ts";

export const ROOM_TZ = "Europe/Brussels";
/** Same window as /book's start times (8am to 10pm), by 15 minutes like Elinor's bookings. */
export const FIRST_START = "08:00";
export const LAST_START = "22:00";
export const STEP_MINUTES = 15;
export const MAX_HOURS = 12;

/** The token price per hour of a room in this token (null when it can't be paid with it). */
export function tokenPricePerHour(product: Pick<Product, "price">, token: Pick<Token, "symbol">): number | null {
  return product.price.find((p) => p.token.toLowerCase() === token.symbol.toLowerCase())?.amount ?? null;
}

export function eurPricePerHour(product: Pick<Product, "price">): number | null {
  return product.price.find((p) => isEuroToken(p.token))?.amount ?? null;
}

export const roomPrice = (perHour: number, start: Date, end: Date) => Number((perHour * (end.getTime() - start.getTime()) / 3600000).toFixed(6));

/** Why this booking can't be made (before looking at the calendar), or null. */
export function checkRoomRequest(product: Pick<Product, "name" | "bookableFrom">, start: Date, end: Date, tz = ROOM_TZ, now = new Date()): string | null {
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return "Choose a valid start and end.";
  if (end <= start) return "The end must be after the start.";
  if (end.getTime() - start.getTime() > MAX_HOURS * 3600000) return `A booking can't be longer than ${MAX_HOURS} hours.`;
  if (start.getTime() < now.getTime() - 5 * 60000) return "The start time has passed.";
  const minutes = (end.getTime() - start.getTime()) / 60000;
  const startMin = minutesOf(localHHMM(start, tz))!;
  if (minutes % STEP_MINUTES !== 0 || startMin % STEP_MINUTES !== 0 || start.getUTCSeconds() !== 0) return `Bookings go by ${STEP_MINUTES} minutes.`;
  if (startMin < minutesOf(FIRST_START)! || startMin > minutesOf(LAST_START)!) return "Bookings start between 8am and 10pm.";
  return checkBookableFrom(product, start, tz);
}

/** The pass page for a guest of a room booking: the signed door link's parameters, then the room. */
export function roomPassUrl(doorLink: string, roomName: string): string {
  const q = new URLSearchParams(new URL(doorLink).search);
  q.set("pass", "room");
  q.set("room", roomName);
  return `${PASS_PAGE_URL}#${q.toString()}`;
}

export type RoomBookingRequest = {
  client: Client | null;
  guildId: string;
  guildSettings: GuildSettings;
  token: Token;
  product: Product;
  booker: { id: string; name: string; username: string; email?: string };
  start: Date;
  end: Date;
  title: string;
  guest?: { name: string; email?: string };
  eventUrl?: string;
  via: "website";
};

export type RoomBookingResult =
  | {
    ok: true;
    eventId?: string;
    price: number;
    hash: string;
    txUrl: string;
    balanceAfter: number;
    invited: boolean;
    /** Email to the guest (or to the booker for themselves); null when there was no address to write to. */
    emailed: boolean | null;
    passUrl?: string;
  }
  | { ok: false; error: string; status: number; paid?: { hash: string; txUrl: string } };

type Deps = {
  conflicts(calendarId: string, start: Date, end: Date): Promise<{ start: string; end: string }[]>;
  burn: typeof burnFromMember;
  createEvent(calendarId: string, event: Record<string, unknown>, invitees: string[]): Promise<{ invited: boolean; inviteError?: string; eventId?: string }>;
  report: typeof reportTransaction;
  roomMessage(client: Client, channelId: string, content: string): Promise<unknown>;
  annotate: typeof publishBookingAnnotation;
  doorLink: typeof buildDoorLink;
  email: typeof sendBookingConfirmation;
  roomImage: typeof fetchRoomImage;
  recordGuest: typeof recordGuestBooking;
  invalidate: () => void;
};

/** The room's events overlapping [start, end) (timed events only, like /book). */
async function calendarConflicts(calendarId: string, start: Date, end: Date) {
  const events = await new GoogleCalendarClient().listEvents(calendarId, start, end) as { start?: { dateTime?: string }; end?: { dateTime?: string } }[];
  return events
    .filter((e) => e.start?.dateTime && e.end?.dateTime && new Date(e.start.dateTime) < end && new Date(e.end.dateTime) > start)
    .map((e) => ({ start: e.start!.dateTime!, end: e.end!.dateTime! }));
}

/**
 * Create the booking event; with invitees through the Workspace account the service account may
 * act for (service accounts cannot invite), else without invitations. Same as /book.
 */
export async function createBookingEvent(calendarId: string, event: Record<string, unknown>, invitees: string[]): Promise<{ invited: boolean; inviteError?: string; eventId?: string }> {
  const asUser = getEnv("BOOKING_CALENDAR_IMPERSONATE_USER") || getEnv("GOOGLE_CALENDAR_IMPERSONATE_USER");
  // deno-lint-ignore no-explicit-any
  const create = async (client: GoogleCalendarClient, e: any, opts?: any) => (await client.createEvent(calendarId, e, opts) as { id?: string })?.id;
  if (invitees.length > 0 && asUser) {
    try {
      const eventId = await create(new GoogleCalendarClient({ impersonateUser: asUser }), { ...event, attendees: invitees.map((email) => ({ email })) }, { sendUpdates: "all" });
      return { invited: true, eventId };
    } catch (error) {
      if ((error as { conflictingEvent?: unknown })?.conflictingEvent) throw error;
      console.error(`[room-booking] could not create the event with invitations as ${asUser}, retrying without:`, (error as Error)?.message || error);
      return { invited: false, inviteError: String((error as Error)?.message || error).slice(0, 160), eventId: await create(new GoogleCalendarClient(), event) };
    }
  }
  await new GoogleCalendarClient().ensureCalendarInList(calendarId).catch(() => {});
  return { invited: false, inviteError: invitees.length ? "no Workspace account configured to send invitations" : undefined, eventId: await create(new GoogleCalendarClient(), event) };
}

const DEFAULT_DEPS: Deps = {
  conflicts: calendarConflicts,
  burn: burnFromMember,
  createEvent: createBookingEvent,
  report: reportTransaction,
  roomMessage: async (client, channelId, content) => {
    const channel = await client.channels.fetch(channelId) as TextChannel | null;
    if (channel && "send" in channel) await channel.send({ content, allowedMentions: { parse: [] } });
  },
  annotate: publishBookingAnnotation,
  doorLink: buildDoorLink,
  email: sendBookingConfirmation,
  roomImage: fetchRoomImage,
  recordGuest: recordGuestBooking,
  invalidate: invalidateRoomEventsCache,
};
let deps: Deps = DEFAULT_DEPS;
/** For tests. */
export function _setRoomBookingDeps(next?: Partial<Deps>) {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
}

const dayLabel = (d: Date, tz: string) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
const hm = (d: Date, tz: string) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });

/**
 * Check, pay, book, tell. Nothing is charged when the request is invalid, the room is taken, the
 * door link for a guest without email can't be signed, or the balance is short. Once paid, a
 * failure to create the event is reported with the transaction (a steward refunds), as in /book.
 */
export async function executeRoomBooking(p: RoomBookingRequest): Promise<RoomBookingResult> {
  const tz = p.guildSettings.guild?.timezone || ROOM_TZ;
  const { product, token, start, end } = p;
  if (!product.calendarId) return { ok: false, error: `${product.name} can't be booked here.`, status: 404 };
  const invalid = checkRoomRequest(product, start, end, tz);
  if (invalid) return { ok: false, error: invalid, status: 400 };
  const perHour = tokenPricePerHour(product, token);
  if (perHour === null) return { ok: false, error: `${product.name} can't be paid with tokens.`, status: 400 };
  const price = roomPrice(perHour, start, end);
  const title = p.title.replace(/[\r\n]+/g, " ").trim().slice(0, 100) || "Room booking";
  const guest = p.guest?.name.trim() ? { name: p.guest.name.replace(/[\r\n<>@]+/g, " ").trim().slice(0, 60), email: p.guest.email } : undefined;

  const taken = await deps.conflicts(product.calendarId, start, end).catch((error) => {
    console.error("[room-booking] could not read the calendar:", error);
    return null;
  });
  if (taken === null) return { ok: false, error: "We couldn't check the room's calendar right now. Nothing was charged; please try again.", status: 503 };
  if (taken.length) return { ok: false, error: `${product.name} is not free then. Nothing was charged.`, status: 409 };

  // A guest without email gets the pass link from the member: sign it before charging anything.
  const doorFor = (name: string) =>
    deps.doorLink({ name, host: p.booker.name, reason: bookingReason(product.name, start, end), start, end }).catch((error) => {
      console.error("[room-booking] door link failed:", error);
      return null;
    });
  let guestDoor: string | null = null;
  if (guest && !guest.email) {
    guestDoor = await doorFor(guest.name);
    if (!guestDoor) return { ok: false, error: "Door links can't be made right now (the door key is not configured). Nothing was charged; tell a steward.", status: 503 };
  }

  const paid = await deps.burn(p.booker.id, token, price, `${product.name} for ${hm(start, tz)}–${hm(end, tz)}`);
  if (!paid.ok) return { ok: false, error: paid.error, status: 402 };
  const txUrl = txUrlFor(token, paid.hash);
  const calendarUrl = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(product.calendarId)}&ctz=${encodeURIComponent(tz)}`;
  const forWhom = guest ? ` for ${guest.name} (guest)` : "";
  const line = `🗓️ <@${p.booker.id}> booked ${product.name}${forWhom} on ${dayLabel(start, tz)} from ${hm(start, tz)} till ${hm(end, tz)} for ${price.toFixed(2)} ${token.symbol} on the website [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`;

  let reportUrl = "";
  const channelId = p.guildSettings.channels?.transactions;
  if (channelId && p.client) {
    try {
      reportUrl = (await deps.report({ client: p.client, channelId, content: line, uris: [txUriFor(token.chain, paid.hash)], currency: token.symbol, category: "rental" })).url;
    } catch (error) {
      console.error("[room-booking] could not report the transaction:", error);
    }
  }

  const now = new Date();
  const description = `Booked by ${p.booker.name} (@${p.booker.username})${guest ? ` on behalf of ${guest.name} (guest)` : ""} on the website on ${dayLabel(now, tz)} at ${hm(now, tz)} for ${price.toFixed(2)} ${token.symbol}\n` +
    `${calendarPaidLine(price, token.symbol)}${calendarTermsLine(token.symbol)}` +
    (reportUrl ? `\n${reportUrl}` : "") +
    (p.eventUrl ? `\nEvent URL: ${p.eventUrl}` : "") +
    `\n\nPlease reach out to @${p.booker.username} on Discord for questions about this booking.\n\nTo cancel, ${p.booker.name} needs to run the /cancel command in Discord.\n\nUser ID: ${p.booker.id}\nBooking TX: ${paid.hash}\nBooking Chain: ${token.chain}`;
  const event: Record<string, unknown> = {
    summary: title,
    description,
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
    ...(p.eventUrl ? { source: { url: p.eventUrl, title: "Event page" } } : {}),
  };
  // Like /book: the guest and the booker are invited when booking for someone else.
  const invitees = guest?.email ? [...new Set([guest.email.toLowerCase(), ...(p.booker.email ? [p.booker.email.toLowerCase()] : [])])] : [];
  let created: { invited: boolean; inviteError?: string; eventId?: string };
  try {
    created = await deps.createEvent(product.calendarId, event, invitees);
  } catch (error) {
    console.error("[room-booking] paid but the event could not be created:", error);
    const conflict = (error as { conflictingEvent?: unknown })?.conflictingEvent;
    return {
      ok: false,
      status: 502,
      error: `${conflict ? `Someone booked ${product.name} at that time just before you` : "The booking could not be saved in the calendar"}, after your payment of ${price.toFixed(2)} tokens went through. A steward will refund you: ask in Discord with this transaction.`,
      paid: { hash: paid.hash, txUrl },
    };
  }
  deps.invalidate();
  await deps.annotate({ chain: token.chain, txHash: paid.hash, roomName: product.name, roomSlug: product.slug, durationMinutes: Math.round((end.getTime() - start.getTime()) / 60000) });
  if (product.channelId && p.client) await deps.roomMessage(p.client, product.channelId, line).catch((error) => console.error("[room-booking] room channel:", error));

  // Emails: the guest (booker in cc), or the booker's own record. Same email as /book.
  const uid = created.eventId ? `${created.eventId}@commonshub.brussels` : `${paid.hash}-0@commonshub.brussels`;
  const occurrences = [{ start, end }];
  const common = { uids: [uid], rates: ratesFromPrices(product.price, product.capacity), eventName: title, roomName: product.name, occurrences, priceTotal: price, tokenSymbol: token.symbol, eventUrl: p.eventUrl, txUrl, bookingId: paid.hash };
  let emailed: boolean | null = null;
  if (guest?.email) {
    const door = await doorFor(guest.name);
    try {
      await deps.email({ ...common, doorLinks: [door], roomImageUrl: await deps.roomImage(product.slug).catch(() => undefined), guestName: guest.name, guestEmail: guest.email, bookerName: p.booker.name, bookerEmail: p.booker.email });
      emailed = true;
    } catch (error) {
      console.error("[room-booking] guest email failed:", error);
      emailed = false;
    }
    if (created.eventId) {
      await deps.recordGuest(p.guildId, {
        calendarId: product.calendarId, eventId: created.eventId, uid, sequence: 0,
        productSlug: product.slug, roomName: product.name,
        guestName: guest.name, guestEmail: guest.email,
        bookerId: p.booker.id, bookerName: p.booker.name, bookerEmail: p.booker.email,
        eventName: title, start: start.toISOString(), end: end.toISOString(), eventUrl: p.eventUrl,
        tokenSymbol: token.symbol, priceTotal: price, status: "active",
      }).catch((error) => console.error("[room-booking] could not record the guest booking:", error));
    }
  } else if (!guest && p.booker.email) {
    const door = await doorFor(p.booker.name);
    try {
      await deps.email({ ...common, forSelf: true, doorLinks: [door], roomImageUrl: await deps.roomImage(product.slug).catch(() => undefined), guestName: p.booker.name, guestEmail: p.booker.email, bookerName: p.booker.name });
      emailed = true;
    } catch (error) {
      console.error("[room-booking] self email failed:", error);
      emailed = false;
    }
  }

  return {
    ok: true,
    eventId: created.eventId,
    price,
    hash: paid.hash,
    txUrl,
    balanceAfter: paid.balanceAfter,
    invited: created.invited,
    emailed,
    ...(guestDoor ? { passUrl: roomPassUrl(guestDoor, product.name) } : {}),
  };
}
