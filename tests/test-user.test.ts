/**
 * Test users (TEST_LOGIN_EMAILS): they sign in with an email code against the test copy of Odoo
 * (their partner made there if missing), pay only in euros, get invoices in the test copy, and a
 * room is checked against the calendar but never booked. The test copy must be neutralized.
 */
import { expect } from "@std/expect/expect";
import { _setLoginDeps, requestCode, verifyCode } from "../src/lib/email-login.ts";
import { _resetNeutralizedCheck, isTestEmail, odooTestFromEnv, type OdooCall } from "../src/lib/odoo.ts";
import { _setWebsiteDeps, handleWebsiteRequest } from "../src/lib/website-api.ts";
import { _setRoomBookingDeps } from "../src/lib/room-booking.ts";
import type { GuildSettings, Product, Token } from "../src/types.ts";

const GUILD = "1280532848604086365";
const TOKEN = "t".repeat(64);
const TEST = "xdamman+test@gmail.com";

function env(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  return () => Object.keys(vars).forEach((k) => Deno.env.delete(k));
}

/** A test Odoo: partners by email, invoices; `created` lists new partners. */
function testOdoo(partners: { id: number; name: string; email: string }[] = []) {
  const created: Record<string, unknown>[] = [];
  const invoices: unknown[] = [];
  let next = 9000;
  const odoo: OdooCall = async (model, method, args = {}) => {
    if (model === "res.partner" && method === "search_read") {
      const d = args.domain as unknown[][];
      const email = d.find((x) => x[0] === "email")?.[2] as string | undefined;
      if (email) return partners.filter((p) => p.email.toLowerCase() === email.replace(/\\(.)/g, "$1").toLowerCase());
      return [];
    }
    if (model === "res.partner" && method === "create") {
      return (args.vals_list as Record<string, unknown>[]).map((v) => {
        const id = next++;
        created.push(v);
        partners.push({ id, name: String(v.name), email: String(v.email) });
        return id;
      });
    }
    if (model === "res.partner" && method === "read") return (args.ids as number[]).map((id) => ({ id, email: partners.find((p) => p.id === id)?.email ?? false, name: "x", type: "contact", parent_id: false }));
    if (model === "res.country") return [{ id: 21 }];
    if (model === "account.account") return [{ id: 555 }];
    if (model === "account.move") {
      if (method === "create") return invoices.push(args) && [700];
      if (method === "action_post") return true;
      if (method === "read" && (args.fields as string[]).includes("payment_state")) return (args.ids as number[]).map((id) => ({ id, payment_state: "not_paid" }));
      if (method === "read") return [{ name: "2026_RCC_T1", amount_untaxed: 42, amount_tax: 8.82, amount_total: 50.82, payment_reference: "+++000/0070/00011+++", invoice_date_due: "2026-12-01", partner_id: [9000, "Test user"] }];
    }
    if (model === "account.move.send.wizard") return method === "create" ? [1] : true;
    throw new Error(`unexpected ${model}.${method}`);
  };
  return { odoo, created, invoices };
}

Deno.test("only listed addresses are test users", () => {
  const done = env({ TEST_LOGIN_EMAILS: ` ${TEST} , other@example.org` });
  try {
    expect(isTestEmail("XDAMMAN+TEST@gmail.com")).toBe(true);
    expect(isTestEmail("xdamman@gmail.com")).toBe(false);
    expect(isTestEmail(undefined)).toBe(false);
  } finally {
    done();
  }
});

Deno.test("the test Odoo is used only when it is a neutralized copy, never production", async () => {
  const flags: Record<string, unknown> = { "https://staging.example|stg": "true", "https://bad.example|live": false };
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const db = new Headers(init?.headers).get("X-Odoo-Database");
    const host = String(url).split("/json/")[0];
    if (String(url).endsWith("/ir.config_parameter/get_param")) return new Response(JSON.stringify(flags[`${host}|${db}`] ?? false));
    return new Response(JSON.stringify([{ id: 1 }]));
  }) as typeof fetch;
  let done = env({ ODOO_URL: "https://prod.example", ODOO_DB: "live", ODOO_TEST_URL: "https://staging.example", ODOO_TEST_DB: "stg", ODOO_API_KEY: "k" });
  try {
    _resetNeutralizedCheck();
    expect(await odooTestFromEnv(fetcher)("res.partner", "search_read", {})).toEqual([{ id: 1 }]);
  } finally {
    done();
  }
  done = env({ ODOO_TEST_URL: "https://bad.example", ODOO_TEST_DB: "live", ODOO_API_KEY: "k" });
  try {
    _resetNeutralizedCheck();
    await expect(odooTestFromEnv(fetcher)("res.partner", "search_read", {})).rejects.toThrow(/not a neutralized copy/);
  } finally {
    done();
  }
  done = env({ ODOO_URL: "https://prod.example", ODOO_DB: "live", ODOO_TEST_URL: "https://prod.example/", ODOO_TEST_DB: "live", ODOO_API_KEY: "k" });
  try {
    _resetNeutralizedCheck();
    await expect(odooTestFromEnv(fetcher)("res.partner", "search_read", {})).rejects.toThrow(/production/);
  } finally {
    done();
    _resetNeutralizedCheck();
  }
});

Deno.test("a test user signs in against the test Odoo, whose partner is made if missing", async () => {
  const done = env({ TEST_LOGIN_EMAILS: TEST });
  const prod: OdooCall = async () => { throw new Error("production Odoo must not be asked about a test user"); };
  const t = testOdoo();
  let code = "";
  _setLoginDeps({ odoo: () => prod, testOdoo: () => t.odoo, send: async (_to, c) => void (code = c), code: () => "654321" });
  try {
    expect(await requestCode(TEST)).toEqual({ ok: true });
    expect(code).toBe("654321");
    expect(t.created).toMatchObject([{ name: "Test user", email: TEST }]);
    expect(await verifyCode(TEST, "654321")).toEqual({ ok: true, partner: { id: 9000, name: "Test user", email: TEST, test: true } });
    expect(t.created.length).toBe(1);
  } finally {
    done();
    _setLoginDeps();
  }
});

// ── Website endpoints ───────────────────────────────────────────────────────

const CHT = { name: "Commons Hub Token", symbol: "CHT", decimals: 6, chain: "celo", address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d", mintable: true } as Token;
const settings = { guild: { id: GUILD, name: "CHB", timezone: "Europe/Brussels" }, channels: {}, tokens: [CHT] } as unknown as GuildSettings;
const ROOMS = [{ slug: "satoshi", type: "room", name: "Satoshi Room", capacity: 15, calendarId: "cal-s", price: [{ token: "CHT", amount: 2 }, { token: "EURb", amount: 60 }] }] as unknown as Product[];
const testUser = { email: TEST, partnerId: 9000, name: "Test user" };
const post = (endpoint: string, body: Record<string, unknown>) =>
  handleWebsiteRequest(new Request(`http://bot/api/website/${endpoint}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ guildId: GUILD, testUser, ...body }) }), `/api/website/${endpoint}`, {} as never);

async function withWebsite(fn: (t: ReturnType<typeof testOdoo>, conflicts: { value: { start: string; end: string }[] }) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const done = env({ DATA_DIR: dir, WEBSITE_API_TOKEN: TOKEN, TEST_LOGIN_EMAILS: TEST });
  const t = testOdoo([{ id: 9000, name: "Test user", email: TEST }]);
  const conflicts = { value: [] as { start: string; end: string }[] };
  const never = (what: string) => async () => { throw new Error(`a test user must not ${what}`); };
  _setWebsiteDeps({
    conflicts: async () => conflicts.value,
    member: never("be looked up in Discord"),
    settings: async () => settings,
    products: async () => ROOMS,
    balance: never("have a token balance read"),
    email: () => undefined,
    dm: never("get a Discord DM"),
    odoo: () => { throw new Error("a test user must not use production Odoo"); },
    testOdoo: () => t.odoo,
    roomBooking: never("book the real calendar"),
    purchase: never("spend tokens"),
    guestPass: never("spend tokens"),
  });
  _setRoomBookingDeps({ createEvent: never("create a calendar event") });
  try {
    await fn(t, conflicts);
  } finally {
    done();
    _setWebsiteDeps();
    _setRoomBookingDeps();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a test user: euros only, flagged as a test", async () => {
  await withWebsite(async () => {
    const o = await (await post("options", {})).json();
    expect(o).toMatchObject({ ok: true, test: true, hasWallet: false, balance: 0, eur: { available: true } });
    for (const e of ["cowork", "guestpass", "book"]) {
      const r = await post(e, { requestId: "req-test-0001" });
      expect(r.status).toBe(403);
    }
    const orgs = await (await post("orgs", {})).json();
    expect(orgs).toMatchObject({ ok: true, me: { name: "Test user", email: TEST } });
  });
});

Deno.test("a test user's room: checked against the calendar, invoiced in the test Odoo, never booked", async () => {
  await withWebsite(async (t, conflicts) => {
    const start = new Date(Date.UTC(2030, 0, 8, 8, 0));
    const body = { requestId: "req-test-0002", room: "satoshi", start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), org: "self" };
    const r = await (await post("paybook", body)).json();
    expect(r).toMatchObject({ ok: true, test: true, eventId: null, room: { name: "Satoshi Room" }, invoice: { number: "2026_RCC_T1", total: 50.82 } });
    expect(t.invoices.length).toBe(1);
    conflicts.value = [{ start: start.toISOString(), end: body.end }];
    const busy = await post("paybook", { ...body, requestId: "req-test-0003" });
    expect(busy.status).toBe(409);
    expect(t.invoices.length).toBe(1);
  });
});

Deno.test("an address not in TEST_LOGIN_EMAILS can't pass as a test user", async () => {
  await withWebsite(async () => {
    const r = await handleWebsiteRequest(new Request("http://bot/api/website/options", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ guildId: GUILD, testUser: { ...testUser, email: "someone@example.org" } }) }), "/api/website/options", {} as never);
    expect(r.status).toBe(403);
  });
});

Deno.test("my bookings: upcoming ones with their invoice, pending until paid by card", async () => {
  await withWebsite(async () => {
    const start = new Date(Date.UTC(2030, 0, 8, 8, 0));
    await post("paybook", { requestId: "req-test-0010", room: "satoshi", start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), org: "self" });
    await post("paycowork", { requestId: "req-test-0011", item: "coworking-half-day", org: "self" });
    let m = await (await post("mine", {})).json();
    expect(m.bookings.map((b: { kind: string; status: string }) => [b.kind, b.status])).toEqual([["cowork", "pending"], ["room", "pending"]]);
    expect(m.bookings[1]).toMatchObject({ label: "Satoshi Room", start: start.toISOString(), invoice: { id: 700, number: "2026_RCC_T1", communication: "+++000/0070/00011+++" } });
    expect((await post("paid", { invoiceId: 999, sessionId: "cs_test_1" })).status).toBe(404);
    expect((await (await post("paid", { invoiceId: 700, sessionId: "cs_test_1" })).json()).ok).toBe(true);
    m = await (await post("mine", {})).json();
    expect(m.bookings.every((b: { status: string }) => b.status === "paid")).toBe(true); // both invoices are 700 in this fake
  });
});
