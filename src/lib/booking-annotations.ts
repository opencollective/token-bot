/**
 * Booking payments, as other tools read them:
 *
 * - The room calendar event gets one structured line chb parses: "Paid: 2 CHT" for token payments,
 *   "Paid: €80 (EURb)" for euro-token payments (the website writes "Paid: €80 (card)" / "Paid: invoice").
 * - The payment (a token burn) gets a Nostr annotation on the community relay, in the format chb
 *   merges: content "Booking Mush Room room for 1h", tags t:booking, t:<room slug>, category:rental.
 *
 * backfillBookingAnnotations re-annotates bookings whose payment has no such annotation yet on the
 * community relay, using the "Booking TX" / "Booking Chain" lines /book writes in each event.
 */
import { ChainConfig, type SupportedChain } from "./blockchain.ts";
import { COMMUNITY_RELAY, Nostr, type URI } from "./nostr.ts";
import { GoogleCalendarClient } from "./googlecalendar.ts";
import type { Product } from "../types.ts";

export const BOOKING_CATEGORY = "rental";

const num = (n: number) => String(Number(n.toFixed(2)));

/** The structured "Paid:" line for the calendar event. */
export function calendarPaidLine(amount: number, tokenSymbol: string): string {
  return /^eur/i.test(tokenSymbol) ? `Paid: €${num(amount)} (${tokenSymbol})` : `Paid: ${num(amount)} ${tokenSymbol}`;
}

/** "1h", "1h30", "45min": same as the annotations already published. */
export function formatBookingDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}`;
}

/** "Booking Mush Room room for 1h", or "Booking Mush Room room for 3 × 1h" for several dates paid at once. */
export function bookingAnnotationContent(roomName: string, durationMinutes: number, dates = 1): string {
  const d = formatBookingDuration(durationMinutes);
  return `Booking ${roomName} room for ${dates > 1 ? `${dates} × ${d}` : d}`;
}

export function bookingAnnotationTags(roomSlug: string): string[][] {
  return [["t", "booking"], ["t", roomSlug], ["category", BOOKING_CATEGORY]];
}

export function txUri(chain: string, txHash: string): URI {
  const chainId = ChainConfig[chain as SupportedChain]?.id;
  if (!chainId) throw new Error(`Unknown chain ${chain}`);
  return `ethereum:${chainId}:tx:${txHash}` as URI;
}

/** Annotate a booking payment. Never throws: the booking is already made. */
export async function publishBookingAnnotation(p: {
  chain: string;
  txHash: string;
  roomName: string;
  roomSlug: string;
  durationMinutes: number;
  dates?: number;
}): Promise<boolean> {
  try {
    await Nostr.getInstance().publishMetadata(txUri(p.chain, p.txHash), {
      content: bookingAnnotationContent(p.roomName, p.durationMinutes, p.dates),
      tags: bookingAnnotationTags(p.roomSlug),
    });
    return true;
  } catch (error) {
    console.error(`[booking] Nostr annotation failed for ${p.txHash}:`, error);
    return false;
  }
}

// ── Backfill ────────────────────────────────────────────────────────────────

export type BookedPayment = {
  txHash: string;
  chain: string;
  roomSlug: string;
  roomName: string;
  durationMinutes: number;
  dates: number;
};

type CalendarEventLike = { description?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };

/** Payments found in room calendar events ("Booking TX:" + "Booking Chain:"), one per tx. */
export function paymentsFromEvents(product: Pick<Product, "slug" | "name">, events: CalendarEventLike[]): BookedPayment[] {
  const byTx = new Map<string, BookedPayment>();
  for (const e of events) {
    const tx = e.description?.match(/Booking TX:\s*(0x[0-9a-fA-F]{64})/)?.[1];
    const chain = e.description?.match(/Booking Chain:\s*(\w+)/)?.[1];
    if (!tx || !chain || !e.start?.dateTime || !e.end?.dateTime) continue;
    const minutes = Math.round((new Date(e.end.dateTime).getTime() - new Date(e.start.dateTime).getTime()) / 60000);
    const key = tx.toLowerCase();
    const existing = byTx.get(key);
    if (existing) existing.dates += 1;
    else byTx.set(key, { txHash: tx, chain, roomSlug: product.slug, roomName: product.name, durationMinutes: minutes, dates: 1 });
  }
  return [...byTx.values()];
}

/**
 * Publish missing booking annotations to the community relay: for each payment in the room
 * calendars (from `daysBack` ago to a year ahead) without an annotation by this bot that has the
 * rental category. Idempotent. Returns what it did.
 */
export async function backfillBookingAnnotations(
  products: Product[],
  opts: { daysBack?: number; dryRun?: boolean } = {},
): Promise<{ checked: number; published: string[]; failed: string[] }> {
  const nostr = Nostr.getInstance();
  const me = nostr.getPublicKey();
  const from = new Date(Date.now() - (opts.daysBack ?? 90) * 86400000);
  const to = new Date(Date.now() + 365 * 86400000);
  const calendar = new GoogleCalendarClient();

  const payments: BookedPayment[] = [];
  for (const product of products.filter((p) => p.type === "room" && p.calendarId)) {
    try {
      payments.push(...paymentsFromEvents(product, await calendar.listEvents(product.calendarId!, from, to)));
    } catch (error) {
      console.error(`[booking-backfill] could not list ${product.slug}:`, error);
    }
  }

  const published: string[] = [], failed: string[] = [];
  for (const p of payments) {
    let uri: URI;
    try {
      uri = txUri(p.chain, p.txHash);
    } catch {
      continue;
    }
    const existing = await nostr.query({ kinds: [1111], authors: [me], "#i": [uri.toLowerCase()] }, 4000, [COMMUNITY_RELAY]).catch(() => null);
    if (existing === null) {
      failed.push(p.txHash);
      continue;
    }
    if (existing.some((e) => e.tags.some((t) => t[0] === "category" && t[1] === BOOKING_CATEGORY))) continue;
    if (opts.dryRun) {
      published.push(p.txHash);
      continue;
    }
    (await publishBookingAnnotation(p) ? published : failed).push(p.txHash);
  }
  return { checked: payments.length, published, failed };
}
