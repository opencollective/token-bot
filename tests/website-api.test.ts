/**
 * /api/website/*: auth, members only, options, idempotent payments (never charged twice), and the
 * room booking from the website (rules, nothing charged before the room is known to be free, guest
 * with or without email).
 */
import { expect } from "@std/expect/expect";
import { _setWebsiteDeps, handleWebsiteRequest } from "../src/lib/website-api.ts";
import { _setRoomBookingDeps, checkRoomRequest, executeRoomBooking, roomPassUrl, roomPrice } from "../src/lib/room-booking.ts";
import { MEMBER_ROLE_BY_GUILD } from "../src/lib/community-roles.ts";
import type { GuildSettings, Product, Token } from "../src/types.ts";

const GUILD = "1280532848604086365";
const USER = "123456789012";
const TOKEN = "t".repeat(64);
const CHT = { name: "Commons Hub Token", symbol: "CHT", decimals: 6, chain: "celo", address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d", mintable: true } as Token;
const settings = { guild: { id: GUILD, name: "CHB", timezone: "Europe/Brussels" }, channels: {}, tokens: [CHT] } as unknown as GuildSettings;
const ROOMS = [
  { slug: "mushroom", type: "room", name: "Mush Room", capacity: 10, calendarId: "cal-mush", price: [{ token: "CHT", amount: 1 }, { token: "EURb", amount: 40 }] },
  { slug: "coworking", type: "room", name: "Coworking", calendarId: "cal-cw", bookableFrom: "19:00", price: [{ token: "CHT", amount: 2 }, { token: "EURb", amount: 50 }] },
  { slug: "eur-only", type: "room", name: "Euro room", calendarId: "cal-e", price: [{ token: "EURb", amount: 10 }] },
] as unknown as Product[];
const HASH = "0x" + "ab".repeat(32);

const member = (roles: string[] = [MEMBER_ROLE_BY_GUILD[GUILD]]) => ({
  user: { bot: false, username: "xdamman", globalName: "Xavier" },
  displayName: "Xavier",
  roles: { cache: { has: (r: string) => roles.includes(r) } },
  permissions: { has: () => false },
  send: async () => {},
});

const client = {} as never;
const post = (endpoint: string, body: Record<string, unknown>, token = TOKEN) =>
  handleWebsiteRequest(new Request(`http://bot/api/website/${endpoint}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ guildId: GUILD, userId: USER, ...body }) }), `/api/website/${endpoint}`, client);

async function withEnv(fn: () => Promise<void>) {
  const dir = await Deno.makeTempDir();
  Deno.env.set("WEBSITE_API_TOKEN", TOKEN);
  Deno.env.set("DATA_DIR", dir);
  try {
    await fn();
  } finally {
    Deno.env.delete("WEBSITE_API_TOKEN");
    Deno.env.delete("DATA_DIR");
    _setWebsiteDeps();
    _setRoomBookingDeps();
    await Deno.remove(dir, { recursive: true });
  }
}

const baseDeps = (over: Parameters<typeof _setWebsiteDeps>[0] = {}) =>
  _setWebsiteDeps({
    member: async () => member() as never,
    settings: async () => settings,
    products: async () => ROOMS,
    balance: async () => 7,
    email: () => "xavier@example.org",
    dm: async () => {},
    ...over,
  });

Deno.test("auth: no token configured rejects everything; a wrong token is 401", async () => {
  Deno.env.delete("WEBSITE_API_TOKEN");
  expect((await post("options", {})).status).toBe(503);
  await withEnv(async () => {
    baseDeps();
    expect((await post("options", {}, "x".repeat(64))).status).toBe(401);
    expect((await post("options", {})).status).toBe(200);
    expect((await post("nope", {})).status).toBe(404);
  });
});

Deno.test("members only, checked again by the bot", async () => {
  await withEnv(async () => {
    baseDeps({ member: async () => member([]) as never });
    const res = await post("options", {});
    expect(res.status).toBe(403);
    expect((await res.json()).ok).toBe(false);
    baseDeps({ member: async () => null });
    expect((await post("options", {})).status).toBe(403);
  });
});

Deno.test("options: balance, coworking for today, guest pass prices, rooms payable with tokens, terms", async () => {
  await withEnv(async () => {
    baseDeps();
    const body = await (await post("options", {})).json();
    expect(body.ok).toBe(true);
    expect(body.balance).toBe(7);
    expect(body.tokenSymbol).toBe("CHT");
    expect(body.cowork.item.id).toBe("coworking-day");
    expect(body.guestPass["half-day"]).toEqual({ price: 1, hours: 5, eur: 15 });
    expect(body.guestPass.day).toEqual({ price: 2, hours: 10, eur: 25 });
    expect(body.guestPass.maxDaysAhead).toBe(7);
    expect(body.rooms.map((r: { slug: string }) => r.slug)).toEqual(["mushroom", "coworking"]);
    expect(body.rooms[0]).toEqual({ slug: "mushroom", name: "Mush Room", capacity: 10, tokenPricePerHour: 1, eurPricePerHour: 40 });
    expect(body.rooms[1].bookableFromNote).toContain("7");
    expect(body.terms.room).toContain("idle");
    expect(body.disclaimer).toContain("Too Good To Go");
  });
});

Deno.test("guest pass: one requestId, one charge, the same answer on retry (also concurrent)", async () => {
  await withEnv(async () => {
    let calls = 0;
    baseDeps({
      guestPass: async (p) => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        expect(p.via).toBe("website");
        expect(p.buyer.email).toBe("xavier@example.org");
        return { ok: true, link: "https://door/open?x=1", pageUrl: "https://commonshub.brussels/pass#x=1&pass=day", guest: "Leo (Xavier's guest)", start: new Date("2026-11-02T09:00:00Z"), end: new Date("2026-11-02T19:00:00Z"), hash: HASH, txUri: "u", balanceAfter: 5, email: { sent: true } };
      },
    });
    const body = { requestId: "req-12345678", length: "day", guestName: "Leo", guestEmail: "leo@example.org" };
    const [a, b] = await Promise.all([post("guestpass", body), post("guestpass", body)]);
    const c = await post("guestpass", body);
    expect(calls).toBe(1);
    const first = await a.json();
    expect(await b.json()).toEqual(first);
    expect(await c.json()).toEqual(first);
    expect(first).toMatchObject({ ok: true, guest: "Leo (Xavier's guest)", passUrl: "https://commonshub.brussels/pass#x=1&pass=day", emailed: true, balanceAfter: 5, price: 2 });
    expect(first.txUrl).toContain(HASH);
    // A new requestId is a new purchase.
    await post("guestpass", { ...body, requestId: "req-87654321" });
    expect(calls).toBe(2);
  });
});

Deno.test("guest pass: refused before paying (bad email, past start, too far, no requestId) and a refusal can be retried", async () => {
  await withEnv(async () => {
    let calls = 0;
    baseDeps({ guestPass: async () => (calls++, { ok: false, error: "Not enough tokens." }) });
    const leo = { requestId: "req-aaaaaaaa", guestName: "Leo" };
    expect((await post("guestpass", { ...leo, guestEmail: "leo@" })).status).toBe(400);
    expect((await post("guestpass", { ...leo, start: new Date(Date.now() - 3600000).toISOString() })).status).toBe(400);
    expect((await post("guestpass", { ...leo, start: new Date(Date.now() + 8 * 86400000).toISOString() })).status).toBe(400);
    expect((await post("guestpass", { guestName: "Leo" })).status).toBe(400);
    // The guest's name is required, the email optional.
    const noName = await post("guestpass", { requestId: "req-aaaaaaaa" });
    expect(noName.status).toBe(400);
    expect((await noName.json()).error).toContain("name");
    expect(calls).toBe(0);
    const r = await post("guestpass", leo);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toContain("Nothing was charged");
    await post("guestpass", leo);
    expect(calls).toBe(2);
  });
});

Deno.test("cowork: /buy's coworking day for today, via the website", async () => {
  await withEnv(async () => {
    baseDeps({
      purchase: async (p) => {
        expect(p.item.id).toBe("coworking-day");
        expect(p.via).toBe("website");
        return { ok: true, hash: HASH, txUri: "u", balanceAfter: 5 };
      },
    });
    const body = await (await post("cowork", { requestId: "req-cowork-1" })).json();
    expect(body).toMatchObject({ ok: true, price: 2, balanceAfter: 5, txHash: HASH });
    expect(body.item.terms).toContain("Contributor coworking");
  });
});

// ── Room booking ────────────────────────────────────────────────────────────

const at = (iso: string) => new Date(iso);
const NOW = new Date("2026-11-02T00:00:00Z");

Deno.test("room rules: 30-minute steps, 8am–10pm starts, 12h at most, not in the past, bookable-from", () => {
  const mush = ROOMS[0], cw = ROOMS[1];
  expect(checkRoomRequest(mush, at("2026-11-02T13:00:00Z"), at("2026-11-02T15:00:00Z"), "Europe/Brussels", NOW)).toBeNull();
  expect(checkRoomRequest(mush, at("2026-11-02T13:30:00Z"), at("2026-11-02T15:00:00Z"), "Europe/Brussels", NOW)).toBeNull();
  expect(checkRoomRequest(mush, at("2026-11-02T13:15:00Z"), at("2026-11-02T15:15:00Z"), "Europe/Brussels", NOW)).toContain("30 minutes");
  expect(checkRoomRequest(mush, at("2026-11-02T13:00:00Z"), at("2026-11-02T13:45:00Z"), "Europe/Brussels", NOW)).toContain("30 minutes");
  expect(checkRoomRequest(mush, at("2026-11-02T05:00:00Z"), at("2026-11-02T06:00:00Z"), "Europe/Brussels", NOW)).toContain("8am");
  expect(checkRoomRequest(mush, at("2026-11-02T08:00:00Z"), at("2026-11-02T21:00:00Z"), "Europe/Brussels", NOW)).toContain("12 hours");
  expect(checkRoomRequest(mush, at("2026-11-01T13:00:00Z"), at("2026-11-01T14:00:00Z"), "Europe/Brussels", NOW)).toContain("passed");
  expect(checkRoomRequest(cw, at("2026-11-02T13:00:00Z"), at("2026-11-02T14:00:00Z"), "Europe/Brussels", NOW)).not.toBeNull();
  expect(checkRoomRequest(cw, at("2026-11-02T18:00:00Z"), at("2026-11-02T20:00:00Z"), "Europe/Brussels", NOW)).toBeNull();
  expect(roomPrice(1, at("2026-11-02T13:00:00Z"), at("2026-11-02T14:30:00Z"))).toBe(1.5);
});

Deno.test("room pass link: the door link's parameters, then pass=room and the room's name", () => {
  const url = roomPassUrl("https://door.commonshub.brussels/open?name=Leo&host=Xavier&sig=0x1&booking=1", "Mush Room");
  expect(url.startsWith("https://commonshub.brussels/pass#")).toBe(true);
  const q = new URLSearchParams(url.split("#")[1]);
  expect(q.get("sig")).toBe("0x1");
  expect(q.get("pass")).toBe("room");
  expect(q.get("room")).toBe("Mush Room");
});

const future = (h: number) => {
  const d = new Date(Date.now() + 2 * 86400000);
  d.setUTCHours(h, 0, 0, 0);
  return d;
};
const roomReq = (over: Partial<Parameters<typeof executeRoomBooking>[0]> = {}) => ({
  client: null,
  guildId: GUILD,
  guildSettings: settings,
  token: CHT,
  product: ROOMS[0],
  booker: { id: USER, name: "Xavier", username: "xdamman", email: "xavier@example.org" },
  start: future(12),
  end: future(14),
  title: "Workshop",
  via: "website" as const,
  ...over,
});

Deno.test("room booking: nothing charged when the room is taken or the calendar can't be read", async () => {
  let burns = 0;
  _setRoomBookingDeps({ conflicts: async () => [{ start: "a", end: "b" }], burn: async () => (burns++, { ok: true, hash: HASH, balanceAfter: 1 }) });
  expect(await executeRoomBooking(roomReq())).toMatchObject({ ok: false, status: 409 });
  _setRoomBookingDeps({ conflicts: async () => { throw new Error("down"); }, burn: async () => (burns++, { ok: true, hash: HASH, balanceAfter: 1 }) });
  expect(await executeRoomBooking(roomReq())).toMatchObject({ ok: false, status: 503 });
  expect(burns).toBe(0);
  _setRoomBookingDeps();
});

Deno.test("room booking for a guest without email: no email, a pass link to share; nothing charged without a door key", async () => {
  let burns = 0, emails = 0;
  const common = { conflicts: async () => [], burn: async (_u: string, _t: Token, amount: number) => (burns++, expect(amount).toBe(2), { ok: true as const, hash: HASH, balanceAfter: 5 }), createEvent: async () => ({ invited: false, eventId: "ev1" }), annotate: async () => true, email: async () => (emails++, { id: "x" }), invalidate: () => {} };
  _setRoomBookingDeps({ ...common, doorLink: async () => null });
  expect(await executeRoomBooking(roomReq({ guest: { name: "Leo" } }))).toMatchObject({ ok: false, status: 503 });
  expect(burns).toBe(0);
  _setRoomBookingDeps({ ...common, doorLink: async (p) => `https://door.commonshub.brussels/open?name=${encodeURIComponent(p.name)}&sig=0x1` });
  const r = await executeRoomBooking(roomReq({ guest: { name: "Leo" } }));
  expect(r).toMatchObject({ ok: true, eventId: "ev1", price: 2, emailed: null, balanceAfter: 5 });
  if (!r.ok) throw new Error("expected ok");
  expect(new URLSearchParams(r.passUrl!.split("#")[1]).get("name")).toBe("Leo");
  expect(emails).toBe(0);
  expect(burns).toBe(1);
  _setRoomBookingDeps();
});

Deno.test("room booking for a guest with email: invited, emailed with the member in cc, recorded", async () => {
  // deno-lint-ignore no-explicit-any
  const sent: any[] = [], invited: string[][] = [], recorded: string[] = [];
  _setRoomBookingDeps({
    conflicts: async () => [],
    burn: async () => ({ ok: true, hash: HASH, balanceAfter: 5 }),
    createEvent: async (_c, _e, invitees) => (invited.push(invitees), { invited: true, eventId: "ev2" }),
    annotate: async () => true,
    doorLink: async () => "https://door/open?sig=1",
    email: async (d) => (sent.push(d), { id: "x" }),
    roomImage: async () => undefined,
    recordGuest: async (_g, r) => { recorded.push(r.guestEmail); },
    invalidate: () => {},
  });
  const r = await executeRoomBooking(roomReq({ guest: { name: "Leo", email: "leo@example.org" } }));
  expect(r).toMatchObject({ ok: true, emailed: true });
  expect(invited[0]).toEqual(["leo@example.org", "xavier@example.org"]);
  expect(sent[0]).toMatchObject({ guestEmail: "leo@example.org", bookerEmail: "xavier@example.org", doorLinks: ["https://door/open?sig=1"], roomName: "Mush Room" });
  expect(recorded).toEqual(["leo@example.org"]);
  _setRoomBookingDeps();
});

Deno.test("room booking for yourself: your own confirmation email; a calendar failure after paying says so with the transaction", async () => {
  // deno-lint-ignore no-explicit-any
  const sent: any[] = [];
  const common = { conflicts: async () => [], burn: async () => ({ ok: true as const, hash: HASH, balanceAfter: 5 }), annotate: async () => true, doorLink: async () => "https://door/open?sig=1", email: async (d: unknown) => (sent.push(d), { id: "x" }), roomImage: async () => undefined, invalidate: () => {} };
  _setRoomBookingDeps({ ...common, createEvent: async () => ({ invited: false, eventId: "ev3" }) });
  expect(await executeRoomBooking(roomReq())).toMatchObject({ ok: true, emailed: true });
  expect(sent[0]).toMatchObject({ forSelf: true, guestEmail: "xavier@example.org" });
  _setRoomBookingDeps({ ...common, createEvent: async () => { throw Object.assign(new Error("taken"), { conflictingEvent: {} }); } });
  const r = await executeRoomBooking(roomReq());
  expect(r).toMatchObject({ ok: false, status: 502 });
  if (r.ok) throw new Error("expected a failure");
  expect(r.paid?.hash).toBe(HASH);
  expect(r.error).toContain("refund");
  _setRoomBookingDeps();
});

Deno.test("/api/website/book: a paid failure is stored (a retry never pays again); a guest needs a name with an email", async () => {
  await withEnv(async () => {
    let calls = 0;
    baseDeps({ roomBooking: async () => (calls++, { ok: false, status: 502, error: "The booking could not be saved… refund", paid: { hash: HASH, txUrl: "https://celoscan.io/tx/" + HASH } }) });
    const start = future(12).toISOString(), end = future(14).toISOString();
    expect((await post("book", { requestId: "req-book-0001", room: "mushroom", start, end, guestEmail: "leo@example.org" })).status).toBe(400);
    const a = await post("book", { requestId: "req-book-0001", room: "mushroom", start, end });
    const b = await post("book", { requestId: "req-book-0001", room: "mushroom", start, end });
    expect(calls).toBe(1);
    expect(a.status).toBe(502);
    expect(await b.json()).toMatchObject({ ok: false, txHash: HASH });
    expect((await post("book", { requestId: "req-book-0002", room: "eur-only", start, end })).status).toBe(404);
  });
});

Deno.test("/api/website/book: a guest booking answers with the guest, emailed or with a pass link", async () => {
  await withEnv(async () => {
    baseDeps({ roomBooking: async (p) => ({ ok: true, eventId: "ev9", price: 2, hash: HASH, txUrl: "t", balanceAfter: 5, invited: false, emailed: null, passUrl: p.guest?.email ? undefined : "https://commonshub.brussels/pass#x&pass=room" }) });
    const start = future(12).toISOString(), end = future(14).toISOString();
    const body = await (await post("book", { requestId: "req-book-0003", room: "mushroom", start, end, guestName: "Leo" })).json();
    expect(body).toMatchObject({ ok: true, room: { slug: "mushroom", name: "Mush Room" }, eventId: "ev9", price: 2, guest: { name: "Leo", emailed: null, passUrl: "https://commonshub.brussels/pass#x&pass=room" } });
    expect(body.title).toBe("Leo (guest of Xavier)");
  });
});

Deno.test("/api/website/availability: price for the span, refusals with a reason", async () => {
  await withEnv(async () => {
    baseDeps({ conflicts: async () => [] });
    const start = future(12).toISOString(), end = future(14).toISOString();
    expect(await (await post("availability", { room: "mushroom", start, end })).json()).toEqual({ ok: true, available: true, price: 2 });
    baseDeps({ conflicts: async () => [{ start, end }] });
    expect(await (await post("availability", { room: "mushroom", start, end })).json()).toMatchObject({ ok: true, available: false, conflicts: [{ start, end }] });
    const odd = await (await post("availability", { room: "mushroom", start: future(12).toISOString(), end: new Date(future(12).getTime() + 10 * 60000).toISOString() })).json();
    expect(odd).toMatchObject({ ok: true, available: false });
    expect(odd.reason).toContain("30 minutes");
  });
});
