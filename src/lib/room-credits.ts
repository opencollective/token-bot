/**
 * Room credits: free hours per week an organisation negotiated, for its contacts in Odoo.
 *
 * The agreement lives on the company in Odoo (custom fields, tab "Room credits"):
 *   x_room_credit_hours  hours per week (Monday to Sunday, Brussels)
 *   x_room_credit_rooms  rooms they apply to, comma-separated slugs or names (empty: all rooms)
 *   x_room_credit_from / x_room_credit_until  optional dates of the agreement
 *
 * Nothing is kept as a balance: what's used is counted, each time, from the rooms' calendars
 * (events whose description carries the credit mark). A cancelled booking (its event deleted)
 * gives its hours back by itself, and unused hours can't carry over to the next week.
 */

import type { OdooCall } from "./odoo.ts";
import type { Product } from "../types.ts";
import { getEnv } from "./utils.ts";

export type Credits = { companyId: number; companyName: string; perWeek: number; rooms: string[] | null; from: string | null; until: string | null };

const FIELDS = ["name", "x_room_credit_hours", "x_room_credit_rooms", "x_room_credit_from", "x_room_credit_until"];

/** The company's agreement, or null when it has none (or Odoo doesn't have the fields). */
export async function creditsOf(odoo: OdooCall, companyId: number): Promise<Credits | null> {
  const [p] = (await odoo("res.partner", "read", { ids: [companyId], fields: FIELDS }).catch(() => [])) as Record<string, unknown>[];
  const perWeek = Number(p?.x_room_credit_hours ?? 0);
  if (!p || !(perWeek > 0)) return null;
  const rooms = typeof p.x_room_credit_rooms === "string" && p.x_room_credit_rooms.trim()
    ? p.x_room_credit_rooms.split(/[,;\n]/).map((s) => norm(s)).filter(Boolean)
    : null;
  const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return { companyId, companyName: String(p.name), perWeek, rooms, from: date(p.x_room_credit_from), until: date(p.x_room_credit_until) };
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/** Whether the credits cover this room ("satoshiroom", "Satoshi Room" and "satoshi" all name it). */
export function coversRoom(c: Credits, product: Pick<Product, "slug" | "name">): boolean {
  if (!c.rooms) return true;
  const names = [norm(product.slug), norm(product.name), norm(product.name).replace(/room$/, "")];
  return c.rooms.map(norm).some((r) => names.includes(r) || names.includes(r.replace(/room$/, "")));
}

/** Whether the agreement runs on that day (YYYY-MM-DD in Brussels). */
export const activeOn = (c: Credits, day: string) => (!c.from || day >= c.from) && (!c.until || day <= c.until);

const TZ = "Europe/Brussels";
const localDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });

/** Midnight in Brussels at the start of that local day, as a Date. */
function brusselsMidnight(day: string): Date {
  const guess = new Date(`${day}T00:00:00Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: TZ }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime()));
}

/** The week (Monday 00:00 to next Monday 00:00, Brussels) that contains `at`. */
export function weekOf(at: Date): { start: Date; end: Date; label: string } {
  const day = localDay(at);
  const noon = new Date(`${day}T12:00:00Z`);
  const back = (noon.getUTCDay() + 6) % 7; // days since Monday
  const monday = new Date(noon.getTime() - back * 86_400_000).toISOString().slice(0, 10);
  const nextMonday = new Date(noon.getTime() + (7 - back) * 86_400_000).toISOString().slice(0, 10);
  return { start: brusselsMidnight(monday), end: brusselsMidnight(nextMonday), label: monday };
}

/** The line a booking's calendar description carries when credits paid for it (read back to count). */
export const creditMark = (companyId: number, hours: number) => `Room credits: ${round(hours)} h (organisation ${companyId})`;
const MARK = /Room credits: ([\d.]+) h \(organisation (\d+)\)/;

export const round = (h: number) => Math.round(h * 100) / 100;

/** Hours of the company's credits these events used. */
export function usedHours(events: { description?: string | null }[], companyId: number): number {
  let total = 0;
  for (const e of events) {
    const m = MARK.exec(e.description ?? "");
    if (m && Number(m[2]) === companyId) total += Number(m[1]);
  }
  return round(total);
}

/** What the credits cover of a booking of `hours`, with `used` hours already booked that week. */
export function split(perWeek: number, used: number, hours: number): { covered: number; overflow: number; leftAfter: number } {
  const left = Math.max(0, round(perWeek - used));
  const covered = round(Math.min(left, hours));
  return { covered, overflow: round(hours - covered), leftAfter: round(left - covered) };
}

const fmtH = (h: number) => `${round(h)} h`;

/** The calendar line for people: what the credits paid and what's left that week. */
export const creditLine = (c: Credits, covered: number, leftAfter: number) =>
  `Paid with room credits: ${fmtH(covered)} of ${c.companyName}'s ${fmtH(c.perWeek)} per week. ${fmtH(leftAfter)} left this week.`;

/** One booking at a time per organisation: two at once could both count the same free hours. */
const locks = new Map<number, Promise<unknown>>();
export function withCreditLock<T>(companyId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(companyId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(companyId, next.catch(() => {}));
  return next;
}

/** A note on the company in Odoo (its chatter), never an invoice. */
export async function logOnCompany(odoo: OdooCall, companyId: number, text: string): Promise<void> {
  await odoo("res.partner", "message_post", { ids: [companyId], body: text, message_type: "comment", subtype_xmlid: "mail.mt_note" });
}

// ── Bookings paid only with credits (no invoice): for the member's dashboard, and cancelling ──

export type CreditBooking = { userId: string; companyId: number; companyName: string; hours: number; label: string; start: string; end: string; calendarId: string; eventId: string; guest?: string; at?: string };
type CreditCancel = { cancelledEventId: string; userId: string; at: string };

const file = (guildId: string) => `${getEnv("DATA_DIR") || "/data"}/${guildId}/website-credit-bookings.jsonl`;

async function rows(guildId: string): Promise<(CreditBooking | CreditCancel)[]> {
  try {
    return (await Deno.readTextFile(file(guildId))).split("\n").filter((l) => l.trim()).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function append(guildId: string, row: unknown) {
  const path = file(guildId);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(row) + "\n", { append: true });
}

export const recordCreditBooking = (guildId: string, b: CreditBooking) => append(guildId, { ...b, at: new Date().toISOString() });

/** The dashboard's shape (like MyBooking, without an invoice): upcoming or past, cancelled ones in past. */
export async function myCreditBookings(guildId: string, userId: string, { now = new Date(), past = false } = {}) {
  const all = await rows(guildId);
  const cancelled = new Set(all.filter((r): r is CreditCancel => "cancelledEventId" in r && r.userId === userId).map((r) => r.cancelledEventId));
  const yearAgo = now.getTime() - 365 * 86_400_000;
  return all
    .filter((r): r is CreditBooking => "eventId" in r && r.userId === userId)
    .filter((r) => {
      const over = Date.parse(r.end) <= now.getTime();
      const gone = cancelled.has(r.eventId);
      return past ? (over || gone) && Date.parse(r.end) > yearAgo : !over && !gone;
    })
    .map((r) => ({
      kind: "room" as const,
      label: r.label,
      start: r.start,
      end: r.end,
      ...(r.guest ? { guest: r.guest } : {}),
      invoice: null,
      eventId: r.eventId,
      status: cancelled.has(r.eventId) ? "cancelled" as const : "credits" as const,
      credits: { hours: r.hours, organisation: r.companyName },
      ...(!cancelled.has(r.eventId) && Date.parse(r.start) > now.getTime() ? { cancel: { refundPercent: 100, refund: 0 } } : {}),
    }));
}

/** Cancel a booking paid with credits, before it starts: the event goes, the hours come back. */
export async function cancelCreditBooking(guildId: string, userId: string, eventId: string, p: { now?: Date; deleteEvent?: (calendarId: string, eventId: string) => Promise<void> }): Promise<{ ok: true; booking: CreditBooking } | { ok: false; error: string; status: number }> {
  const all = await rows(guildId);
  const b = all.find((r): r is CreditBooking => "eventId" in r && r.eventId === eventId && r.userId === userId);
  if (!b) return { ok: false, error: "That booking isn't yours, or it can't be cancelled here.", status: 404 };
  if (all.some((r) => "cancelledEventId" in r && r.cancelledEventId === eventId)) return { ok: false, error: "This booking is already cancelled.", status: 409 };
  if (Date.parse(b.start) <= (p.now ?? new Date()).getTime()) return { ok: false, error: "This booking has already started.", status: 409 };
  if (p.deleteEvent) {
    try {
      await p.deleteEvent(b.calendarId, b.eventId);
    } catch (e) {
      // Already gone from the calendar (a steward deleted it): still cancelled here.
      if (!/404|410|not ?found|deleted/i.test(String((e as Error)?.message ?? e))) return { ok: false, error: "We couldn't free the room in the calendar right now. Please try again.", status: 503 };
    }
  }
  await append(guildId, { cancelledEventId: eventId, userId, at: new Date().toISOString() });
  return { ok: true, booking: b };
}
