/**
 * Guest passes (/guestpass, propose_guest_pass for Elinor): a member pays with their own tokens
 * for a door link they share with a guest, valid half a day (5 hours) or a full day.
 *
 * Priced like contributor coworking (a guest pass is coworking paid with tokens, for someone
 * else): the half day costs what a contributor coworking half day costs, the full day what a day
 * costs (src/lib/shop.ts). The price is burned from the buyer's own account through the same
 * purchase code as /buy, so it is annotated on Nostr and reported in the transactions channel like
 * any coworking purchase. The guest's name and email never go there (public relay): they stay in
 * the bot's data volume, DATA_DIR/<guild>/guest-passes.jsonl.
 *
 * The link is the door's signed link (door-link.ts, booking=1): the door posts
 * "🚪 Leo (Xavier's guest) opened the door for a guest pass (9am-2pm) (booked by Xavier)".
 * The door accepts a signed link from 30 minutes before its start until 30 minutes after its end,
 * so the signed window is 30 minutes shorter at each end: the link works exactly for the pass.
 */
import { Client } from "discord.js";
import { buildDoorLink, timeRange } from "./door-link.ts";
import { executePurchase, findShopItem, type PurchaseResult, type ShopItem } from "./shop.ts";
import { COWORKING_TOKEN_TERMS } from "./token-terms.ts";
import { getEnv } from "./utils.ts";
import type { GuildSettings, Token } from "../types.ts";

export type GuestPassLength = "half-day" | "day";

export type GuestPassItem = ShopItem & { hours: number; length: GuestPassLength };

/** Desk coworking in euros, excl. VAT (commonshub.brussels/coworking shows them with "+ VAT"); Xavier set the half day at €15. */
export const COWORKING_EUR: Record<GuestPassLength, number> = { "half-day": 15, "day": 25 };

/** The pass page on the website: commonshub.brussels/pass#<signed door-link parameters>&pass=<length>. */
export const PASS_PAGE_URL = "https://commonshub.brussels/pass";

/** The cost line of a pass: "Half day: €15 (+ VAT) or 1 token", "Full day: €25 (+ VAT) or 2 tokens". */
export function passCost(item: Pick<GuestPassItem, "length" | "price">): string {
  const t = `${item.price} token${item.price === 1 ? "" : "s"}`;
  return `${item.length === "day" ? "Full day" : "Half day"}: €${COWORKING_EUR[item.length]} (+ VAT) or ${t}`;
}

/**
 * Plain-language fine print under a pass, for the guest (email and pass page): same text as the
 * website's PASS_DISCLAIMER (src/lib/guest-pass.ts there), based on the membership poster's fine print.
 */
export const PASS_DISCLAIMER =
  "Spaces paid with tokens are only offered when there is spare, unsold capacity, a bit like Too Good To Go: there's no guaranteed desk or room, and it is not a commercial rental. " +
  "Membership fees support the association and are not payment for a service; anything bought with money (coworking, renting a room, an event ticket) is invoiced separately, with VAT.";

/**
 * The page to share: the signed door-link parameters in the fragment (never sent to the website's
 * server), plus the pass length for display. The page's button opens the real signed link.
 */
export function passPageUrl(doorLink: string, length: GuestPassLength): string {
  const q = new URLSearchParams(new URL(doorLink).search);
  q.set("pass", length);
  return `${PASS_PAGE_URL}#${q.toString()}`;
}

/** The door's grace before and after a signed link's window (door server, verifyEventOrganizerSignature). */
export const DOOR_GRACE_MINUTES = 30;
/** How far ahead a pass can start. */
export const MAX_DAYS_AHEAD = 7;
export const TZ = "Europe/Brussels";

const coworkingPrice = (id: string, fallback: number) => findShopItem(id)?.price ?? fallback;

export const GUEST_PASSES: Record<GuestPassLength, GuestPassItem> = {
  "half-day": {
    id: "guest-pass-half-day",
    length: "half-day",
    label: "Guest pass, half day",
    hours: 5,
    price: coworkingPrice("coworking-half-day", 1),
    category: "coworking",
    terms: COWORKING_TOKEN_TERMS,
  },
  "day": {
    id: "guest-pass-day",
    length: "day",
    label: "Guest pass, full day",
    hours: 10,
    price: coworkingPrice("coworking-day", 2),
    category: "coworking",
    terms: COWORKING_TOKEN_TERMS,
  },
};

export function guestPassItem(length: string | null | undefined): GuestPassItem | undefined {
  const l = (length ?? "half-day").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (l === "half-day" || l === "half" || l === "halfday") return GUEST_PASSES["half-day"];
  if (l === "day" || l === "full-day" || l === "full" || l === "fullday") return GUEST_PASSES["day"];
  return undefined;
}

const clean = (s: string | null | undefined, max = 60) => s?.replace(/[&=\r\n<>@#`*_~|]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || undefined;

/** "Xavier's guest", or "Leo (Xavier's guest)" with a name. */
export function guestLabel(memberName: string, guestName?: string | null): string {
  const member = clean(memberName, 40) || "A member";
  const guest = clean(guestName, 40);
  return guest ? `${guest} (${member}'s guest)` : `${member}'s guest`;
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
export function normalizeEmail(email: string | null | undefined): string | undefined | null {
  const e = email?.trim();
  if (!e) return undefined;
  return EMAIL_RE.test(e) && e.length <= 200 ? e : null;
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** The offset of `tz` from UTC at `date`, in minutes (Brussels: 60 or 120). */
function offsetMinutes(date: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** The instant when the wall clock in `tz` shows this date and time. */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz = TZ): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
  t = guess - offsetMinutes(new Date(t), tz) * 60000; // settle around DST changes
  return new Date(t);
}

function wallDate(date: Date, tz = TZ): { y: number; m: number; d: number } {
  const [y, m, d] = date.toLocaleDateString("en-CA", { timeZone: tz }).split("-").map(Number);
  return { y, m, d };
}

/**
 * When the pass starts. Empty: now. Accepts "14:00", "14h", "2pm", "9:30am", "tomorrow 9:00",
 * "25/10 9:00", "25/10/2026 14:00", "2026-10-25 09:00" or an ISO 8601 date-time with timezone
 * (Elinor). Times are Brussels time. Up to 15 minutes in the past is taken as now.
 */
export function parseStart(input: string | null | undefined, now = new Date(), tz = TZ): { start: Date } | { error: string } {
  const raw = input?.trim().toLowerCase();
  if (!raw || raw === "now") return { start: now };
  const tooFar = () => ({ error: `A guest pass can start at most ${MAX_DAYS_AHEAD} days ahead.` });
  const check = (start: Date) => {
    if (start.getTime() < now.getTime() - 15 * 60000) return { error: `${start.toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })} is in the past. Leave the start empty for now, or give a later time (e.g. "tomorrow 9:00").` };
    if (start.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86400000) return tooFar();
    return { start: start.getTime() < now.getTime() ? now : start };
  };

  // ISO 8601 with a timezone (or Z): trust it as is.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(input!.trim());
    return isNaN(d.getTime()) ? { error: `"${input}" is not a valid date.` } : check(d);
  }

  let day = wallDate(now, tz);
  let rest = raw;
  const dayWord = rest.match(/^(today|tomorrow)\b\s*(at\s+)?/);
  const dmy = rest.match(/^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\s+(at\s+)?/);
  const ymd = rest.match(/^(\d{4})-(\d{2})-(\d{2})(?:t|\s+)(at\s+)?/);
  if (dayWord) {
    if (dayWord[1] === "tomorrow") day = wallDate(new Date(zonedTime(day.y, day.m, day.d, 12, 0, tz).getTime() + 86400000), tz);
    rest = rest.slice(dayWord[0].length);
  } else if (ymd) {
    day = { y: +ymd[1], m: +ymd[2], d: +ymd[3] };
    rest = rest.slice(ymd[0].length);
  } else if (dmy) {
    const y = dmy[3] ? (dmy[3].length === 2 ? 2000 + +dmy[3] : +dmy[3]) : day.y;
    day = { y, m: +dmy[2], d: +dmy[1] };
    rest = rest.slice(dmy[0].length);
    if (!dmy[3] && zonedTime(day.y, day.m, day.d, 23, 59, tz) < now) day.y += 1;
  }
  const t = rest.trim().match(/^(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm|h)?$/);
  if (!t) return { error: `"${input}" isn't a time I understand. Try "14:00", "2pm", "tomorrow 9:00" or "25/10 9:30".` };
  let h = +t[1];
  const min = t[2] ? +t[2] : 0;
  if (t[3] === "pm" && h < 12) h += 12;
  if (t[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59 || day.m < 1 || day.m > 12 || day.d < 1 || day.d > 31) return { error: `"${input}" isn't a valid time.` };
  const start = zonedTime(day.y, day.m, day.d, h, min, tz);
  if (wallDate(start, tz).d !== day.d) return { error: `"${input}" isn't a valid date.` };
  return check(start);
}

export function passWindow(start: Date, item: GuestPassItem): { start: Date; end: Date } {
  return { start, end: new Date(start.getTime() + item.hours * 3600000) };
}

/** "today, 9:00–14:00", "Fri 24 Oct, 9:00–19:00" (Brussels time). */
export function whenLabel(start: Date, end: Date, now = new Date(), tz = TZ): string {
  const t = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  const sameDay = (a: Date, b: Date) => a.toLocaleDateString("en-CA", { timeZone: tz }) === b.toLocaleDateString("en-CA", { timeZone: tz });
  const day = sameDay(start, now) ? "today" : start.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz });
  return `${day}, ${t(start)}–${t(end)}${sameDay(start, end) ? "" : " (next day)"}`;
}

/** What #door shows: "… opened the door for a guest pass (9am-2pm) (booked by Xavier)". */
export function guestPassReason(start: Date, end: Date, tz = TZ): string {
  return `a guest pass (${timeRange(start, end, tz)})`;
}

/** The signed door link, working exactly from start to end. Null without DOOR_SIGNING_KEY. */
export async function buildGuestPassLink(
  p: { guest: string; host: string; start: Date; end: Date },
  privateKey = getEnv("DOOR_SIGNING_KEY"),
  now = new Date(),
): Promise<string | null> {
  const grace = DOOR_GRACE_MINUTES * 60000;
  return await buildDoorLink({
    name: p.guest,
    host: p.host,
    reason: guestPassReason(p.start, p.end),
    start: new Date(p.start.getTime() + grace),
    end: new Date(p.end.getTime() - grace),
  }, privateKey, now);
}

// ── Records ─────────────────────────────────────────────────────────────────

export interface GuestPassRecord {
  id: string;
  guildId: string;
  item: string;
  price: number;
  tokenSymbol: string;
  buyerId: string;
  buyerName: string;
  guest: string;
  guestName?: string;
  guestEmail?: string;
  start: string;
  end: string;
  txHash: string;
  via: "command" | "elinor" | "website";
  emailed?: boolean;
  createdAt: string;
}

const fileFor = (guildId: string) => `${getEnv("DATA_DIR") || "/data"}/${guildId}/guest-passes.jsonl`;

export async function recordGuestPass(r: GuestPassRecord): Promise<void> {
  const path = fileFor(r.guildId);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(r) + "\n", { append: true });
}

// ── The purchase ────────────────────────────────────────────────────────────

export type GuestPassRequest = {
  client: Client;
  guildId: string;
  guildSettings: GuildSettings;
  token: Token;
  item: GuestPassItem;
  buyer: { id: string; name: string; email?: string };
  guestName?: string;
  guestEmail?: string;
  start: Date;
  via: "command" | "elinor" | "website";
};

export type GuestPassResult =
  | { ok: true; link: string; pageUrl: string; guest: string; start: Date; end: Date; hash: string; txUri: string; balanceAfter: number; reportUrl?: string; email?: { sent: boolean; error?: string } }
  | { ok: false; error: string };

type Deps = {
  link: typeof buildGuestPassLink;
  purchase: typeof executePurchase;
  record: typeof recordGuestPass;
  email: (d: import("./guest-pass-email.ts").GuestPassEmail) => Promise<unknown>;
};
const DEFAULT_DEPS: Deps = {
  link: buildGuestPassLink,
  purchase: executePurchase,
  record: recordGuestPass,
  email: async (d) => (await import("./guest-pass-email.ts")).sendGuestPassEmail(d),
};
let deps = DEFAULT_DEPS;
/** For tests. */
export function _setGuestPassDeps(next?: Partial<Deps>) {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
}

/**
 * Sign the door link first (nothing is charged when the door key is missing), then burn the price
 * from the buyer's own account, record the pass, and email the guest when an address is given.
 * An email failure does not undo the pass: the buyer has the link and is told.
 */
export async function executeGuestPass(p: GuestPassRequest): Promise<GuestPassResult> {
  const { start, end } = passWindow(p.start, p.item);
  const guest = guestLabel(p.buyer.name, p.guestName);
  const link = await deps.link({ guest, host: p.buyer.name, start, end }).catch((e) => {
    console.error("[guest-pass] could not sign the door link:", e);
    return null;
  });
  if (!link) return { ok: false, error: "Door links can't be made right now (the door key is not configured). Nothing was charged; tell a steward." };

  const purchase: PurchaseResult = await deps.purchase({
    client: p.client,
    guildSettings: p.guildSettings,
    token: p.token,
    item: p.item,
    buyer: { id: p.buyer.id, name: p.buyer.name },
    description: `for a guest, ${whenLabel(start, end)}`,
    via: p.via,
  });
  if (!purchase.ok) return purchase;

  let email: { sent: boolean; error?: string } | undefined;
  if (p.guestEmail) {
    try {
      await deps.email({
        guestName: clean(p.guestName, 40),
        guestEmail: p.guestEmail,
        hostName: p.buyer.name,
        hostEmail: p.buyer.email,
        start,
        end,
        doorLink: link,
        passUrl: passPageUrl(link, p.item.length),
        length: p.item.length,
        cost: passCost(p.item),
      });
      email = { sent: true };
    } catch (error) {
      console.error("[guest-pass] email failed:", error);
      email = { sent: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  await deps.record({
    id: purchase.hash,
    guildId: p.guildId,
    item: p.item.id,
    price: p.item.price,
    tokenSymbol: p.token.symbol,
    buyerId: p.buyer.id,
    buyerName: p.buyer.name,
    guest,
    ...(p.guestName ? { guestName: clean(p.guestName, 40) } : {}),
    ...(p.guestEmail ? { guestEmail: p.guestEmail } : {}),
    start: start.toISOString(),
    end: end.toISOString(),
    txHash: purchase.hash,
    via: p.via,
    ...(email ? { emailed: email.sent } : {}),
    createdAt: new Date().toISOString(),
  }).catch((error) => console.error("[guest-pass] could not record the pass:", error));

  return { ok: true, link, pageUrl: passPageUrl(link, p.item.length), guest, start, end, hash: purchase.hash, txUri: purchase.txUri, balanceAfter: purchase.balanceAfter, reportUrl: purchase.reportUrl, email };
}

/** The message with the link, for the buyer only (ephemeral reply or DM). */
export function linkMessage(r: Extract<GuestPassResult, { ok: true }>, item: GuestPassItem, now = new Date()): string {
  const emailLine = r.email
    ? r.email.sent ? "📨 Your guest was emailed the link and how to get in." : `⚠️ The email to your guest failed (${(r.email.error ?? "").slice(0, 120)}): send them the link yourself.`
    : "Share it with your guest (by message, not in a public channel).";
  return [
    `🎟️ **${item.label}** for **${r.guest}**, ${whenLabel(r.start, r.end, now)}.`,
    `🎟️ Pass to share with your guest: <${r.pageUrl}>`,
    `-# The page has a button that opens the door, only in that window. Anyone with the link can open the door then, and #door shows "${r.guest}".`,
    emailLine,
  ].join("\n");
}
