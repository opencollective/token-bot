/**
 * /api/website/*: what commonshub.brussels does for a signed-in member, without sending them to
 * Discord: buy contributor coworking for today (/buy), a guest pass (/guestpass), a room for
 * themselves or a guest (/book). The member confirms on the website; the bot pays from their own
 * account and does what the commands do (reports, emails, door links).
 *
 * Auth: Bearer WEBSITE_API_TOKEN (the website, which checked the Discord session and the member
 * role). The bot checks again that the user is a member of the guild. Every paying call carries a
 * `requestId`: a retry returns the first answer and never charges twice.
 */
import { Client, GuildMember } from "discord.js";
import { loadGuildFile, loadGuildSettings, getEnv } from "./utils.ts";
import { executePurchase, findShopItem, shopToken, SHOP_ITEMS, type ShopItem, FOR_TODAY } from "./shop.ts";
import { COWORKING_EUR, executeGuestPass, guestPassItem, GUEST_PASSES, MAX_DAYS_AHEAD, normalizeEmail, PASS_DISCLAIMER, linkMessage, type GuestPassLength } from "./guest-pass.ts";
import { checkRoomRequest, eurPricePerHour, executeRoomBooking, roomPrice, tokenPricePerHour } from "./room-booking.ts";
import { bookableFromMessage } from "./room-rules.ts";
import { COWORKING_TOKEN_TERMS, ROOM_TOKEN_TERMS } from "./token-terms.ts";
import { getUserEmail } from "./user-emails.ts";
import { txUrlFor } from "./mint.ts";
import { isGuildMember } from "../commands/guestpass.ts";
import { clip } from "./discord-text.ts";
import { GoogleCalendarClient } from "./googlecalendar.ts";
import type { GuildSettings, Product, Token } from "../types.ts";

type Json = Record<string, unknown>;
type Answer = { status: number; body: Json };
const ok = (body: Json, status = 200): Answer => ({ status, body: { ok: true, ...body } });
const fail = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

/** Constant-time bearer check. */
export function websiteAuthorized(req: Request, secret = getEnv("WEBSITE_API_TOKEN")): boolean {
  if (!secret) return false;
  const auth = req.headers.get("Authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// ── Idempotency ─────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<Answer>>();
const fileFor = (guildId: string) => `${getEnv("DATA_DIR") || "/data"}/${guildId}/website-requests.jsonl`;

async function storedAnswer(guildId: string, key: string): Promise<Answer | null> {
  try {
    const text = await Deno.readTextFile(fileFor(guildId));
    for (const line of text.split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line) as { key: string; answer: Answer };
      if (r.key === key) return r.answer;
    }
  } catch { /* no file yet */ }
  return null;
}

async function storeAnswer(guildId: string, key: string, answer: Answer) {
  const path = fileFor(guildId);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify({ key, answer, at: new Date().toISOString() }) + "\n", { append: true });
}

/**
 * Run a paying call once per (guild, user, requestId). A concurrent retry waits for the first; a
 * later one reads the stored answer. Refusals before any payment are not stored, so the member
 * can fix the request and retry with the same id.
 */
async function once(guildId: string, userId: string, requestId: unknown, run: () => Promise<Answer & { charged?: boolean }>): Promise<Answer> {
  if (typeof requestId !== "string" || !/^[\w-]{8,64}$/.test(requestId)) return fail("requestId is required");
  const key = `${guildId}:${userId}:${requestId}`;
  const running = inFlight.get(key);
  if (running) return await running;
  const p = (async () => {
    const stored = await storedAnswer(guildId, key);
    if (stored) return stored;
    const { charged, ...answer } = await run();
    if (answer.body.ok || charged) await storeAnswer(guildId, key, answer).catch((e) => console.error("[website-api] could not store the answer:", e));
    return answer;
  })();
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

// ── Context ─────────────────────────────────────────────────────────────────

type Deps = {
  member(client: Client, guildId: string, userId: string): Promise<GuildMember | null>;
  settings: typeof loadGuildSettings;
  products(guildId: string): Promise<Product[]>;
  balance(userId: string, token: Token): Promise<number | null>;
  purchase: typeof executePurchase;
  guestPass: typeof executeGuestPass;
  roomBooking: typeof executeRoomBooking;
  conflicts(calendarId: string, start: Date, end: Date): Promise<{ start: string; end: string }[]>;
  dm(member: GuildMember, content: string): Promise<unknown>;
  email(guildId: string, userId: string): string | undefined;
};

const DEFAULT_DEPS: Deps = {
  member: async (client, guildId, userId) => {
    if (!/^\d{5,25}$/.test(userId)) return null;
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    return guild ? await guild.members.fetch(userId).catch(() => null) : null;
  },
  settings: loadGuildSettings,
  products: async (guildId) => ((await loadGuildFile(guildId, "products.json")) as unknown as Product[] | null) ?? [],
  balance: async (userId, token) => {
    const { getSenderBalance } = await import("./send.ts");
    const { formatUnits } = await import("@wevm/viem");
    const found = await getSenderBalance(userId, token);
    return found ? Number(formatUnits(found.balance, token.decimals)) : null;
  },
  purchase: executePurchase,
  guestPass: executeGuestPass,
  roomBooking: executeRoomBooking,
  conflicts: async (calendarId, start, end) => {
    const events = await new GoogleCalendarClient().listEvents(calendarId, start, end) as { start?: { dateTime?: string }; end?: { dateTime?: string } }[];
    return events
      .filter((e) => e.start?.dateTime && e.end?.dateTime && new Date(e.start.dateTime) < end && new Date(e.end.dateTime) > start)
      .map((e) => ({ start: e.start!.dateTime!, end: e.end!.dateTime! }));
  },
  dm: (member, content) => member.send({ content }),
  email: getUserEmail,
};
let deps: Deps = DEFAULT_DEPS;
/** For tests. */
export function _setWebsiteDeps(next?: Partial<Deps>) {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
}

type Ctx = { guildId: string; userId: string; member: GuildMember; name: string; settings: GuildSettings; token: Token };

async function context(client: Client | null, body: Json): Promise<Ctx | Answer> {
  const guildId = typeof body.guildId === "string" ? body.guildId : "";
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!/^\d{5,25}$/.test(guildId) || !/^\d{5,25}$/.test(userId)) return fail("guildId and userId are required");
  if (!client) return fail("The bot is starting, please try again in a minute.", 503);
  const member = await deps.member(client, guildId, userId);
  if (!member || member.user.bot) return fail("You're not in the community's Discord server.", 403);
  if (!isGuildMember(member, guildId)) return fail("This is for members.", 403);
  const settings = await deps.settings(guildId);
  const token = shopToken(settings);
  if (!settings || !token) return fail("Paying with tokens is not available right now.", 503);
  const name = member.displayName || member.user.globalName || member.user.username;
  return { guildId, userId, member, name, settings, token };
}

const isAnswer = (x: Ctx | Answer): x is Answer => "status" in x && "body" in x;
const str = (b: Json, k: string, max = 200) => (typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim().slice(0, max) : undefined);
const itemJson = (i: ShopItem) => ({ id: i.id, label: i.label, price: i.price, terms: i.terms });

// ── Endpoints ───────────────────────────────────────────────────────────────

async function options(c: Ctx): Promise<Answer> {
  const balance = await deps.balance(c.userId, c.token).catch(() => null);
  const products = await deps.products(c.guildId);
  const rooms = products
    .filter((p) => p.type === "room" && p.calendarId && tokenPricePerHour(p, c.token) !== null)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      ...(p.capacity ? { capacity: p.capacity } : {}),
      tokenPricePerHour: tokenPricePerHour(p, c.token),
      eurPricePerHour: eurPricePerHour(p),
      ...(p.bookableFrom ? { bookableFromNote: bookableFromMessage(p) } : {}),
    }));
  const pass = (l: GuestPassLength) => ({ price: GUEST_PASSES[l].price, hours: GUEST_PASSES[l].hours, eur: COWORKING_EUR[l] });
  return ok({
    balance: balance ?? 0,
    hasWallet: balance !== null,
    tokenSymbol: c.token.symbol,
    cowork: { item: itemJson(findShopItem("coworking-day")!), items: SHOP_ITEMS.map(itemJson), note: FOR_TODAY },
    guestPass: { "half-day": pass("half-day"), "day": pass("day"), maxDaysAhead: MAX_DAYS_AHEAD },
    rooms,
    terms: { cowork: COWORKING_TOKEN_TERMS, room: ROOM_TOKEN_TERMS },
    disclaimer: PASS_DISCLAIMER,
  });
}

async function findRoom(c: Ctx, slug: unknown): Promise<Product | null> {
  // Only rooms that can be paid with tokens, as listed in options.
  return (await deps.products(c.guildId)).find((p) => p.slug === slug && p.type === "room" && p.calendarId && tokenPricePerHour(p, c.token) !== null) ?? null;
}

async function availability(c: Ctx, b: Json): Promise<Answer> {
  const product = await findRoom(c, b.room);
  if (!product) return fail("Unknown room.", 404);
  const start = new Date(String(b.start ?? "")), end = new Date(String(b.end ?? ""));
  const perHour = tokenPricePerHour(product, c.token)!;
  const tz = c.settings.guild?.timezone || "Europe/Brussels";
  const reason = checkRoomRequest(product, start, end, tz);
  if (reason) return ok({ available: false, reason, price: isNaN(end.getTime() - start.getTime()) || end <= start ? 0 : roomPrice(perHour, start, end) });
  const conflicts = await deps.conflicts(product.calendarId!, start, end).catch(() => null);
  if (conflicts === null) return fail("We couldn't check the room's calendar right now.", 503);
  return ok({
    available: conflicts.length === 0,
    ...(conflicts.length ? { reason: `${product.name} is not free then.`, conflicts } : {}),
    price: roomPrice(perHour, start, end),
  });
}

async function cowork(client: Client, c: Ctx, b: Json): Promise<Answer & { charged?: boolean }> {
  const item = findShopItem(str(b, "item", 40) ?? "coworking-day");
  if (!item) return fail("Unknown item.");
  const r = await deps.purchase({ client, guildSettings: c.settings, token: c.token, item, buyer: { id: c.userId, name: c.name }, via: "website" });
  if (!r.ok) return fail(`${r.error.replace(/<@\d+>/g, "you")} Nothing was charged.`, 402);
  return { ...ok({ item: itemJson(item), price: item.price, balanceAfter: r.balanceAfter, txHash: r.hash, txUrl: txUrlFor(c.token, r.hash) }), charged: true };
}

async function guestPass(client: Client, c: Ctx, b: Json): Promise<Answer & { charged?: boolean }> {
  const item = guestPassItem(str(b, "length", 20));
  if (!item) return fail("Choose a half day or a full day.");
  let start = new Date();
  if (b.start !== undefined && b.start !== null && b.start !== "") {
    start = new Date(String(b.start));
    if (isNaN(start.getTime())) return fail("Choose a valid start time.");
    if (start.getTime() < Date.now() - 15 * 60000) return fail("The start time has passed.");
    if (start.getTime() > Date.now() + MAX_DAYS_AHEAD * 86400000) return fail(`A pass can start at most ${MAX_DAYS_AHEAD} days ahead.`);
  }
  const guestName = str(b, "guestName", 60);
  if (!guestName) return fail("Tell us your guest's name.");
  const guestEmail = normalizeEmail(str(b, "guestEmail", 200));
  if (guestEmail === null) return fail("That guest email doesn't look valid.");
  const r = await deps.guestPass({
    client,
    guildId: c.guildId,
    guildSettings: c.settings,
    token: c.token,
    item,
    buyer: { id: c.userId, name: c.name, email: deps.email(c.guildId, c.userId) },
    guestName,
    guestEmail,
    start,
    via: "website",
  });
  if (!r.ok) return fail(`${r.error.replace(/<@\d+>/g, "you")}${/Nothing was charged/.test(r.error) ? "" : " Nothing was charged."}`, 402);
  // Like /guestpass: a copy of the link by DM, so they keep it.
  await deps.dm(c.member, clip(linkMessage(r, item))).catch(() => {});
  return {
    ...ok({
      guest: r.guest,
      start: r.start.toISOString(),
      end: r.end.toISOString(),
      passUrl: r.pageUrl,
      emailed: r.email ? r.email.sent : null,
      balanceAfter: r.balanceAfter,
      txHash: r.hash,
      txUrl: txUrlFor(c.token, r.hash),
      price: item.price,
    }),
    charged: true,
  };
}

async function book(client: Client, c: Ctx, b: Json): Promise<Answer & { charged?: boolean }> {
  const product = await findRoom(c, b.room);
  if (!product) return fail("Unknown room.", 404);
  const guestName = str(b, "guestName", 60);
  const rawEmail = str(b, "guestEmail", 200);
  const guestEmail = normalizeEmail(rawEmail);
  if (guestEmail === null) return fail("That guest email doesn't look valid.");
  if (guestEmail && !guestName) return fail("Tell us your guest's name.");
  const start = new Date(String(b.start ?? "")), end = new Date(String(b.end ?? ""));
  const r = await deps.roomBooking({
    client,
    guildId: c.guildId,
    guildSettings: c.settings,
    token: c.token,
    product,
    booker: { id: c.userId, name: c.name, username: c.member.user.username, email: deps.email(c.guildId, c.userId) },
    start,
    end,
    title: str(b, "title", 100) ?? (guestName ? `${guestName} (guest of ${c.name})` : "Room booking"),
    ...(guestName ? { guest: { name: guestName, ...(guestEmail ? { email: guestEmail } : {}) } } : {}),
    via: "website",
  });
  if (!r.ok) {
    return { ...fail(r.error, r.status), ...(r.paid ? { charged: true, body: { ok: false, error: r.error, txHash: r.paid.hash, txUrl: r.paid.txUrl } } : {}) };
  }
  return {
    ...ok({
      room: { slug: product.slug, name: product.name },
      start: start.toISOString(),
      end: end.toISOString(),
      title: str(b, "title", 100) ?? (guestName ? `${guestName} (guest of ${c.name})` : "Room booking"),
      eventId: r.eventId ?? null,
      price: r.price,
      balanceAfter: r.balanceAfter,
      txHash: r.hash,
      txUrl: r.txUrl,
      emailed: guestName ? undefined : r.emailed,
      ...(guestName ? { guest: { name: guestName, emailed: guestEmail ? r.emailed : null, ...(r.passUrl ? { passUrl: r.passUrl } : {}) } } : {}),
    }),
    charged: true,
  };
}

/** Route one /api/website/* request. */
export async function handleWebsiteRequest(req: Request, path: string, client: Client | null): Promise<Response> {
  const reply = (a: Answer) => new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  if (!getEnv("WEBSITE_API_TOKEN")) return reply(fail("WEBSITE_API_TOKEN not configured", 503));
  if (!websiteAuthorized(req)) return reply(fail("Unauthorized", 401));
  if (req.method !== "POST") return reply(fail("Method not allowed", 405));
  let body: Json;
  try {
    body = await req.json();
  } catch {
    return reply(fail("Invalid JSON body"));
  }
  const endpoint = path.slice("/api/website/".length);
  if (!["options", "availability", "cowork", "guestpass", "book"].includes(endpoint)) return reply(fail("Not found", 404));
  try {
    const c = await context(client, body);
    if (isAnswer(c)) return reply(c);
    if (endpoint === "options") return reply(await options(c));
    if (endpoint === "availability") return reply(await availability(c, body));
    const run = endpoint === "cowork" ? () => cowork(client!, c, body) : endpoint === "guestpass" ? () => guestPass(client!, c, body) : () => book(client!, c, body);
    return reply(await once(c.guildId, c.userId, body.requestId, run));
  } catch (error) {
    console.error(`[website-api] ${endpoint} failed:`, error);
    return reply(fail("Something went wrong on our side. Nothing was charged unless you got a confirmation; please try again.", 500));
  }
}
