/**
 * Room booking rules from products.json, shared by /book, the HTTP booking API and Elinor's MCP tools.
 *
 * bookableFrom: "HH:MM" in the hub's timezone. A booking can't start before it (e.g. the coworking
 * space, only bookable from 19:00). Same field as the website's rooms.json.
 */
import type { Product } from "../types.ts";

/** "19:00" → 1140, or null when missing or malformed. */
export function minutesOf(hhmm: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm?.trim() ?? "");
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** "19:00" → "7pm", "19:30" → "7:30pm", "09:00" → "9am". */
export function timeLabel(hhmm: string): string {
  const t = minutesOf(hhmm);
  if (t === null) return hhmm;
  const h = Math.floor(t / 60), m = t % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h >= 12 ? "pm" : "am"}`;
}

/** "The coworking space", "The Mush Room", "The Phone booth". */
function roomLabel(product: Pick<Product, "name">): string {
  return /room|booth/i.test(product.name) ? `The ${product.name}` : `The ${product.name.toLowerCase()} space`;
}

/** The message shown when a start time is too early, e.g. "The coworking space can only be booked from 7pm." */
export function bookableFromMessage(product: Pick<Product, "name" | "bookableFrom">): string {
  return `${roomLabel(product)} can only be booked from ${timeLabel(product.bookableFrom ?? "")}.`;
}

/** Is a start time given as "HH:MM" (hub local time) allowed for this room? */
export function startTimeAllowed(product: Pick<Product, "bookableFrom">, hhmm: string): boolean {
  const from = minutesOf(product.bookableFrom);
  const start = minutesOf(hhmm);
  return from === null || start === null || start >= from;
}

/** "HH:MM" of a date in a timezone. */
export function localHHMM(date: Date, timezone = "Europe/Brussels"): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });
}

/** Check a start Date; returns the error message, or null when allowed. */
export function checkBookableFrom(
  product: Pick<Product, "name" | "bookableFrom">,
  start: Date,
  timezone = "Europe/Brussels",
): string | null {
  return startTimeAllowed(product, localHHMM(start, timezone)) ? null : bookableFromMessage(product);
}
