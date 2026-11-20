/**
 * Paying in euros: the member price and VAT, organisations a member may invoice (and only theirs),
 * the invoice as Odoo gets it (RCC journal, account 700003, 21% services tax, 30% discount on the
 * line), VIES lookups, and the website endpoints that book a room or coworking with an invoice.
 */
import { expect } from "@std/expect/expect";
import { checkOrgInput, createInvoice, listOrgs, lookupVat, parseViesAddress, quote, roomLine, saveOrg } from "../src/lib/euro-billing.ts";
import { _setWebsiteDeps, handleWebsiteRequest } from "../src/lib/website-api.ts";
import { _setRoomBookingDeps } from "../src/lib/room-booking.ts";
import { MEMBER_ROLE_BY_GUILD } from "../src/lib/community-roles.ts";
import type { OdooCall } from "../src/lib/odoo.ts";
import type { GuildSettings, Product, Token } from "../src/types.ts";

const GUILD = "1280532848604086365";
const USER = "123456789012";
const TOKEN = "t".repeat(64);

type Call = { model: string; method: string; args: Record<string, unknown> };

/** A tiny in-memory Odoo: partners, one account, invoices. */
function fakeOdoo() {
  const calls: Call[] = [];
  const partners: Record<number, Record<string, unknown>> = {
    7: { id: 7, name: "Xavier", email: "xavier@example.org", is_company: false, street: "Rue A 1", zip: "1000", city: "Brussels", country_code: "BE", vat: false, type: "contact", parent_id: false, active: true },
  };
  let next = 100;
  const match = (p: Record<string, unknown>, domain: unknown[][]) =>
    domain.every(([f, op, v]) => {
      const val = f === "parent_id" ? (p.parent_id as [number, string] | false || [false])[0] : p[f as string];
      if (op === "=ilike") return String(val ?? "").toLowerCase() === String(v).toLowerCase();
      return (val ?? false) === v;
    });
  const odoo: OdooCall = async (model, method, args = {}) => {
    calls.push({ model, method, args });
    if (model === "res.partner") {
      if (method === "message_post") return 1;
      if (method === "search_read") return Object.values(partners).filter((p) => p.active !== false && match(p, args.domain as unknown[][])).slice(0, 1);
      if (method === "read") return (args.ids as number[]).map((id) => partners[id]).filter(Boolean);
      if (method === "create") {
        return (args.vals_list as Record<string, unknown>[]).map((v) => {
          const id = next++;
          partners[id] = { id, active: true, type: "contact", parent_id: false, country_code: "BE", vat: false, ...v, ...(v.parent_id ? { parent_id: [v.parent_id, "parent"] } : {}) };
          return id;
        });
      }
      if (method === "write") {
        for (const id of args.ids as number[]) Object.assign(partners[id], args.vals);
        return true;
      }
    }
    if (model === "res.partner" && method === "message_post") return 1;
    if (model === "res.country") return [{ id: 21 }];
    if (model === "account.account") return [{ id: 555 }];
    if (model === "account.move") {
      if (method === "create") return [900];
      if (method === "action_post") return true;
      if (method === "read") return [{ name: "2026_RCC_0105", amount_untaxed: 42, amount_tax: 8.82, amount_total: 50.82, payment_reference: "+++000/0090/00073+++", invoice_date_due: "2026-12-01", partner_id: [args.ids && 100, "Acme SRL"] }];
    }
    if (model === "account.move.send.wizard") return method === "create" ? [1] : true;
    throw new Error(`unexpected ${model}.${method}`);
  };
  return { odoo, calls, partners };
}

async function withDataDir(fn: () => Promise<void>) {
  const dir = await Deno.makeTempDir();
  Deno.env.set("DATA_DIR", dir);
  try {
    await fn();
  } finally {
    Deno.env.delete("DATA_DIR");
    await Deno.remove(dir, { recursive: true });
  }
}

const ACME = { name: "Acme SRL", vat: "be 0123.456.789", email: "billing@acme.example", address: { street: "Rue B 2", zip: "1050", city: "Ixelles", country: "BE" } };

Deno.test("member price: 30% off before VAT, then 21%", () => {
  const q = quote([roomLine("Satoshi Room", 60, 1, true, "Tue 17 Nov")]);
  expect(q).toMatchObject({ untaxed: 42, vat: 8.82, total: 50.82, discount: 30 });
  expect(quote([{ label: "Coworking half day", quantity: 1, unitPrice: 15, discount: 30 }])).toMatchObject({ untaxed: 10.5, vat: 2.21, total: 12.71 });
  expect(quote([{ label: "Coworking day", quantity: 1, unitPrice: 25, discount: 30 }])).toMatchObject({ untaxed: 17.5, vat: 3.68, total: 21.18 });
  expect(quote([roomLine("Satoshi Room", 60, 1.5, false, "x")])).toMatchObject({ untaxed: 90, vat: 18.9, total: 108.9, discount: 0 });
});

Deno.test("organisation input is checked before anything reaches Odoo", () => {
  expect(checkOrgInput(ACME)).toBeNull();
  expect(checkOrgInput({ ...ACME, email: "nope" })).toMatch(/email/);
  expect(checkOrgInput({ ...ACME, vat: "12" })).toMatch(/VAT/);
  expect(checkOrgInput({ ...ACME, address: { ...ACME.address, city: "" } })).toMatch(/address/);
  expect(checkOrgInput({ ...ACME, billing: { street: "", zip: "", city: "", country: "BE" } })).toMatch(/billing/);
});

Deno.test("a member adds an organisation with a billing address and only sees their own", async () => {
  await withDataDir(async () => {
    const { odoo, partners } = fakeOdoo();
    const saved = await saveOrg(odoo, GUILD, USER, "xavier@example.org", { ...ACME, billing: { street: "PO Box 12", zip: "1040", city: "Etterbeek", country: "BE" } });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.org).toMatchObject({ name: "Acme SRL", vat: "BE0123456789", billing: { street: "PO Box 12", city: "Etterbeek" } });
    expect(partners[saved.org.id].is_company).toBe(true);

    const mine = await listOrgs(odoo, GUILD, USER, "xavier@example.org");
    expect(mine.map((o) => [o.name, !!o.self])).toEqual([["Acme SRL", false], ["Xavier", true]]);
    // Someone else sees neither Acme nor Xavier's partner.
    expect(await listOrgs(odoo, GUILD, "999999999999", "other@example.org")).toEqual([]);
    const theirs = await saveOrg(odoo, GUILD, "999999999999", "other@example.org", { ...ACME, id: saved.org.id, name: "Hijack" });
    expect(theirs).toMatchObject({ ok: false, status: 403 });

    // Unticking the billing address archives it.
    const again = await saveOrg(odoo, GUILD, USER, "xavier@example.org", { ...ACME, id: saved.org.id, billing: null });
    expect(again.ok && again.org.billing).toBe(null);
  });
});

Deno.test("the invoice: RCC journal, account 700003, 21% services tax, discount on the line, billing address", async () => {
  await withDataDir(async () => {
    const { odoo, calls } = fakeOdoo();
    const saved = await saveOrg(odoo, GUILD, USER, "xavier@example.org", { ...ACME, billing: { street: "PO Box 12", zip: "1040", city: "Etterbeek", country: "BE" } });
    if (!saved.ok) throw new Error("not saved");
    const r = await createInvoice(odoo, { guildId: GUILD, userId: USER, member: { name: "Xavier", email: "xavier@example.org" }, to: saved.org.id, lines: [roomLine("Satoshi Room", 60, 1, true, "Tue 17 Nov 08:30–09:30")], ref: "Satoshi Room Tue 17 Nov" });
    expect(r).toMatchObject({ ok: true, invoice: { number: "2026_RCC_0105", total: 50.82, communication: "+++000/0090/00073+++", sentTo: "billing@acme.example", emailed: true } });
    const create = calls.find((c) => c.model === "account.move" && c.method === "create")!;
    const vals = (create.args.vals_list as Record<string, unknown>[])[0];
    expect(vals).toMatchObject({ move_type: "out_invoice", journal_id: 11, partner_id: saved.org.billing!.id });
    expect((vals.invoice_line_ids as unknown[][])[0][2]).toEqual({ name: "Satoshi Room, Tue 17 Nov 08:30–09:30", quantity: 1, price_unit: 60, discount: 30, account_id: 555, tax_ids: [[6, 0, [163]]] });
    expect(calls.some((c) => c.model === "account.move" && c.method === "action_post")).toBe(true);

    // Not one of theirs: refused before any invoice.
    const n = calls.length;
    expect(await createInvoice(odoo, { guildId: GUILD, userId: USER, member: { name: "Xavier" }, to: 4242, lines: [], ref: "x" })).toMatchObject({ ok: false, status: 403 });
    expect(calls.slice(n).some((c) => c.model === "account.move")).toBe(false);
  });
});

Deno.test("VIES: valid numbers fill in name and address", async () => {
  expect(parseViesAddress("RUE DE LA MADELEINE 51\n1000 BRUXELLES", "BE")).toEqual({ street: "RUE DE LA MADELEINE 51", zip: "1000", city: "BRUXELLES", country: "BE" });
  const fetcher = (async (url: string) => {
    expect(url).toBe("https://ec.europa.eu/taxation_customs/vies/rest-api/ms/BE/vat/0123456789");
    return new Response(JSON.stringify({ isValid: true, name: "ACME SRL", address: "RUE B 2\n1050 IXELLES" }));
  }) as typeof fetch;
  expect(await lookupVat("BE 0123.456.789", fetcher)).toEqual({ valid: true, name: "ACME SRL", address: { street: "RUE B 2", zip: "1050", city: "IXELLES", country: "BE" } });
  expect(await lookupVat("nope", (async () => new Response(JSON.stringify({ isValid: false }))) as unknown as typeof fetch)).toEqual({ valid: false });
});

// ── Website endpoints ───────────────────────────────────────────────────────

const CHT = { name: "Commons Hub Token", symbol: "CHT", decimals: 6, chain: "celo", address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d", mintable: true } as Token;
const settings = { guild: { id: GUILD, name: "CHB", timezone: "Europe/Brussels" }, channels: {}, tokens: [CHT] } as unknown as GuildSettings;
const ROOMS = [{ slug: "satoshi", type: "room", name: "Satoshi Room", capacity: 15, calendarId: "cal-s", price: [{ token: "CHT", amount: 2 }, { token: "EURb", amount: 60 }] }] as unknown as Product[];
const member = { user: { bot: false, username: "xdamman" }, displayName: "Xavier", roles: { cache: { has: (r: string) => r === MEMBER_ROLE_BY_GUILD[GUILD] } }, permissions: { has: () => false }, send: async () => {} };
const post = (endpoint: string, body: Record<string, unknown>) =>
  handleWebsiteRequest(new Request(`http://bot/api/website/${endpoint}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ guildId: GUILD, userId: USER, ...body }) }), `/api/website/${endpoint}`, {} as never);

async function withWebsite(odoo: OdooCall | null, fn: (events: Record<string, unknown>[]) => Promise<void>) {
  await withDataDir(async () => {
    Deno.env.set("WEBSITE_API_TOKEN", TOKEN);
    const events: Record<string, unknown>[] = [];
    _setWebsiteDeps({ conflicts: async () => [], member: async () => member as never, settings: async () => settings, products: async () => ROOMS, balance: async () => 7, email: () => "xavier@example.org", dm: async () => {}, odoo: () => odoo });
    _setRoomBookingDeps({
      conflicts: async () => [],
      burn: async () => { throw new Error("no tokens when paying in euros"); },
      createEvent: async (_c, e) => { events.push(e); return { invited: false, eventId: "evt1" }; },
      report: async () => { throw new Error("no transaction report for an invoice"); },
      annotate: async () => { throw new Error("no on-chain annotation for an invoice"); },
      doorLink: async () => "https://door/x",
      email: async () => ({ id: "mail1" }),
      roomImage: async () => undefined,
      recordGuest: async () => {},
      invalidate: () => {},
    });
    try {
      await fn(events);
    } finally {
      Deno.env.delete("WEBSITE_API_TOKEN");
      _setWebsiteDeps();
      _setRoomBookingDeps();
    }
  });
}

Deno.test("options and availability carry the euro prices", async () => {
  await withWebsite(fakeOdoo().odoo, async () => {
    const o = await (await post("options", {})).json();
    expect(o.eur).toMatchObject({ available: true, memberDiscount: 30, vatRate: 21 });
    expect(o.eur.cowork["coworking-half-day"]).toMatchObject({ total: 12.71 });
    const start = new Date(Date.UTC(2030, 0, 8, 8, 0)); // a Tuesday, 09:00 in Brussels
    const a = await (await post("availability", { room: "satoshi", start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString() })).json();
    expect(a.eur).toMatchObject({ untaxed: 42, vat: 8.82, total: 50.82 });
  });
});

Deno.test("book a room in euros: invoice first, then the calendar; no tokens, retry-safe", async () => {
  const { odoo, calls } = fakeOdoo();
  await withWebsite(odoo, async (events) => {
    const start = new Date(Date.UTC(2030, 0, 8, 8, 0));
    const body = { requestId: "req-eur-0001", room: "satoshi", start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), org: "self" };
    const r = await (await post("paybook", body)).json();
    expect(r).toMatchObject({ ok: true, room: { name: "Satoshi Room" }, invoice: { number: "2026_RCC_0105", total: 50.82, communication: "+++000/0090/00073+++" } });
    expect(String(events[0].description)).toContain("invoice 2026_RCC_0105");
    const again = await (await post("paybook", body)).json();
    expect(again.invoice.number).toBe("2026_RCC_0105");
    expect(calls.filter((c) => c.model === "account.move" && c.method === "create").length).toBe(1);
    expect(events.length).toBe(1);
  });
});

Deno.test("coworking in euros, and euro payments off without Odoo", async () => {
  await withWebsite(fakeOdoo().odoo, async () => {
    const r = await (await post("paycowork", { requestId: "req-eur-0002", item: "coworking-half-day", org: "self" })).json();
    expect(r).toMatchObject({ ok: true, item: { id: "coworking-half-day" }, invoice: { number: "2026_RCC_0105" } });
    expect((await (await post("paycowork", { requestId: "req-eur-0003", item: "coworking-day" })).json()).error).toMatch(/invoice/);
  });
  await withWebsite(null, async () => {
    const o = await (await post("options", {})).json();
    expect(o.eur.available).toBe(false);
    const res = await post("orgs", {});
    expect(res.status).toBe(503);
  });
});

Deno.test("invoices speak English unless the organisation picks French or Dutch; the billing contact follows", async () => {
  await withDataDir(async () => {
    const { odoo, partners } = fakeOdoo();
    const saved = await saveOrg(odoo, GUILD, USER, "xavier@example.org", { ...ACME, billing: { street: "PO Box 12", zip: "1040", city: "Etterbeek", country: "BE" } });
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.org.lang).toBe("en_GB");
    const child = () => Object.values(partners).find((p) => p.type === "invoice" && p.active !== false)!;
    expect(child()).toMatchObject({ lang: "en_GB", email: "billing@acme.example" });
    const fr = await saveOrg(odoo, GUILD, USER, "xavier@example.org", { ...ACME, id: saved.org.id, email: "compta@acme.example", lang: "fr_BE", billing: { street: "PO Box 12", zip: "1040", city: "Etterbeek", country: "BE" } });
    expect(fr.ok && fr.org.lang).toBe("fr_BE");
    expect(child()).toMatchObject({ lang: "fr_BE", email: "compta@acme.example" });
    // Not one of the three: left as it was.
    const odd = await saveOrg(odoo, GUILD, USER, "xavier@example.org", { ...ACME, id: saved.org.id, lang: "de_DE" });
    expect(odd.ok && odd.org.lang).toBe("fr_BE");
  });
});

Deno.test("a company already in Odoo (same VAT number) is linked, not duplicated, and its details kept", async () => {
  await withDataDir(async () => {
    const { odoo, partners, calls } = fakeOdoo();
    partners[47] = { id: 47, name: "Acme SRL (in our books)", email: "ap@acme.example", is_company: true, vat: "BE0123456789", street: "Rue C 3", zip: "1000", city: "Brussels", country_code: "BE", type: "contact", parent_id: false, active: true, lang: "nl_BE" };
    const saved = await saveOrg(odoo, GUILD, USER, "xavier@example.org", { ...ACME, name: "ACME" });
    expect(saved.ok && saved.org).toMatchObject({ id: 47, name: "Acme SRL (in our books)", existing: true, lang: "nl_BE" });
    expect(calls.some((c) => c.model === "res.partner" && (c.method === "create" || c.method === "write"))).toBe(false);
    expect((await listOrgs(odoo, GUILD, USER, "xavier@example.org")).map((o) => o.id)).toContain(47);
  });
});

Deno.test("the company Odoo has a member as a contact of is one of their organisations, to invoice but not to edit", async () => {
  await withDataDir(async () => {
    const { odoo, partners } = fakeOdoo();
    partners[127] = { id: 127, name: "RCR ASBL", email: "admin@rcr.example", is_company: true, vat: "BE0999999999", street: "Rue D 4", zip: "1000", city: "Brussels", country_code: "BE", type: "contact", parent_id: false, active: true };
    partners[7].parent_id = [127, "RCR ASBL"];
    const orgs = await listOrgs(odoo, GUILD, USER, "xavier@example.org");
    expect(orgs.map((o) => [o.id, !!o.contact, !!o.self])).toEqual([[127, true, false], [7, false, true]]);
    expect(await saveOrg(odoo, GUILD, USER, "xavier@example.org", { ...ACME, id: 127 })).toMatchObject({ ok: false, status: 403 });
    const r = await createInvoice(odoo, { guildId: GUILD, userId: USER, member: { name: "Xavier", email: "xavier@example.org" }, to: 127, lines: [roomLine("Satoshi Room", 60, 1, true, "x")], ref: "x" });
    expect(r.ok).toBe(true);
    // Someone else can't invoice it.
    expect(await createInvoice(odoo, { guildId: GUILD, userId: "999999999999", member: { name: "Other", email: "other@example.org" }, to: 127, lines: [], ref: "x" })).toMatchObject({ ok: false, status: 403 });
  });
});

Deno.test("emailUser: someone known to Odoo by email sees their organisations and bookings, pays in euros only", async () => {
  const { odoo, partners } = fakeOdoo();
  partners[127] = { id: 127, name: "RCR ASBL", email: "admin@rcr.example", is_company: true, vat: false, street: "Rue D 4", zip: "1000", city: "Brussels", country_code: "BE", type: "contact", parent_id: false, active: true };
  partners[1276] = { id: 1276, name: "Barbara", email: "barbara@donut.example", is_company: false, vat: false, street: false, zip: false, city: false, country_code: false, type: "contact", parent_id: [127, "RCR ASBL"], active: true };
  await withWebsite(odoo, async () => {
    const as = (endpoint: string, email: string) => post(endpoint, { userId: undefined, emailUser: { email } });
    const r = await (await as("orgs", "Barbara@donut.example")).json();
    expect(r.orgs.map((o: { id: number; contact?: boolean }) => [o.id, !!o.contact])).toEqual([[127, true], [1276, false]]);
    expect(r.me).toEqual({ name: "Barbara", email: "barbara@donut.example" });
    expect((await (await as("mine", "barbara@donut.example")).json()).ok).toBe(true);
    expect((await as("book", "barbara@donut.example")).status).toBe(403);
    expect((await as("orgs", "nobody@donut.example")).status).toBe(404);
  });
});

// ── Room credits ────────────────────────────────────────────────────────────

import { coversRoom, split, usedHours, weekOf } from "../src/lib/room-credits.ts";

Deno.test("room credits: the week, what's covered, what's counted", () => {
  // Sunday 23:30 in Brussels is still last week; Monday 00:30 starts the next.
  expect(weekOf(new Date("2026-11-22T22:30:00Z")).label).toBe("2026-11-16");
  expect(weekOf(new Date("2026-11-22T23:30:00Z")).label).toBe("2026-11-23");
  expect(weekOf(new Date("2026-11-25T10:00:00Z")).start.toISOString()).toBe("2026-11-22T23:00:00.000Z");
  expect(split(3, 2, 2)).toEqual({ covered: 1, overflow: 1, leftAfter: 0 });
  expect(split(3, 0, 1.5)).toEqual({ covered: 1.5, overflow: 0, leftAfter: 1.5 });
  expect(split(3, 4, 1)).toEqual({ covered: 0, overflow: 1, leftAfter: 0 });
  expect(usedHours([{ description: "x\nRoom credits: 2 h (organisation 127)\ny" }, { description: "Room credits: 1 h (organisation 99)" }, {}], 127)).toBe(2);
  const c = { companyId: 127, companyName: "RCR", perWeek: 3, rooms: ["mushroom", "satoshiroom", "phonebooth"], from: null, until: null };
  expect(coversRoom(c, { slug: "satoshiroom", name: "Satoshi Room" })).toBe(true);
  expect(coversRoom(c, { slug: "ostromroom", name: "Ostrom Room" })).toBe(false);
  expect(coversRoom({ ...c, rooms: ["Satoshi"] }, { slug: "satoshiroom", name: "Satoshi Room" })).toBe(true);
});

Deno.test("room credits: a contact of the organisation books with its credits, the rest is invoiced, cancelling gives the hours back", async () => {
  const { odoo, calls, partners } = fakeOdoo();
  partners[127] = { id: 127, name: "RCR ASBL", email: "admin@rcr.example", is_company: true, vat: false, street: "Rue D 4", zip: "1000", city: "Brussels", country_code: "BE", type: "contact", parent_id: false, active: true, x_room_credit_hours: 3, x_room_credit_rooms: "satoshiroom", x_room_credit_from: false, x_room_credit_until: false };
  partners[7].parent_id = [127, "RCR ASBL"];
  await withWebsite(odoo, async (events) => {
    const calendar: { description?: string }[] = [];
    const deleted: string[] = [];
    _setWebsiteDeps({ conflicts: async () => [], member: async () => member as never, settings: async () => settings, products: async () => ROOMS, balance: async () => 7, email: () => "xavier@example.org", dm: async () => {}, odoo: () => odoo, events: async () => calendar, deleteEvent: async (_c, id) => void deleted.push(id) });
    const start = new Date(Date.UTC(2030, 0, 8, 8, 0));
    const at = (h: number) => new Date(start.getTime() + h * 3600000).toISOString();

    // 2 h, all covered: no invoice, the calendar says so.
    const r = await (await post("paybook", { requestId: "req-cred-0001", room: "satoshi", start: at(0), end: at(2), org: "127" })).json();
    expect(r).toMatchObject({ ok: true, invoice: null, credits: { hours: 2, left: 1, perWeek: 3, organisation: "RCR ASBL" } });
    expect(calls.some((c) => c.model === "account.move" && c.method === "create")).toBe(false);
    const desc = String(events[0].description);
    expect(desc).toContain("Paid with room credits: 2 h of RCR ASBL's 3 h per week. 1 h left this week.");
    expect(desc).toContain("Room credits: 2 h (organisation 127)");
    const note = calls.find((c) => c.method === "message_post")!;
    expect(note.args).toMatchObject({ ids: [127] });
    expect(String(note.args.body)).toMatch(/2 h of room credits, 1 h left this week of 3 h/);
    calendar.push({ description: desc });

    // 2 h more that week: 1 h covered, 1 h invoiced.
    const r2 = await (await post("paybook", { requestId: "req-cred-0002", room: "satoshi", start: at(3), end: at(5), org: "127" })).json();
    expect(r2).toMatchObject({ ok: true, credits: { hours: 1, left: 0 }, invoice: { number: "2026_RCC_0105" } });
    const move = calls.find((c) => c.model === "account.move" && c.method === "create")!;
    const line = ((move.args.vals_list as Record<string, unknown>[])[0].invoice_line_ids as unknown[][])[0][2] as Record<string, unknown>;
    expect(line).toMatchObject({ quantity: 1, price_unit: 60 });
    expect(String(line.name)).toContain("beyond room credits");

    // On the dashboard, and cancelled before it starts: the event goes.
    const mine = await (await post("mine", {})).json();
    const credited = mine.bookings.find((b: { status: string }) => b.status === "credits");
    expect(credited).toMatchObject({ invoice: null, credits: { hours: 2, organisation: "RCR ASBL" }, cancel: { refundPercent: 100 } });
    const c = await (await post("cancelbooking", { eventId: credited.eventId })).json();
    expect(c).toMatchObject({ ok: true, credits: 2 });
    expect(deleted).toEqual([credited.eventId]);
    expect((await (await post("cancelbooking", { eventId: credited.eventId })).json()).ok).toBe(false);
  });
});

Deno.test("room credits: not for someone who only added the organisation themselves, nor another room", async () => {
  const { odoo, calls, partners } = fakeOdoo();
  partners[127] = { id: 127, name: "RCR ASBL", email: "admin@rcr.example", is_company: true, vat: "BE0999999999", street: "Rue D 4", zip: "1000", city: "Brussels", country_code: "BE", type: "contact", parent_id: false, active: true, x_room_credit_hours: 3, x_room_credit_rooms: "mushroom" };
  partners[7].parent_id = [127, "RCR ASBL"];
  await withWebsite(odoo, async () => {
    const start = new Date(Date.UTC(2030, 0, 8, 8, 0));
    const r = await (await post("paybook", { requestId: "req-cred-0003", room: "satoshi", start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), org: "127" })).json();
    expect(r.credits).toBeUndefined();
    expect(r.invoice.number).toBe("2026_RCC_0105");
    expect(calls.some((c) => c.method === "message_post")).toBe(false);
  });
});

Deno.test("room credits: the availability check says what they'd cover", async () => {
  const { odoo, partners } = fakeOdoo();
  partners[127] = { id: 127, name: "RCR ASBL", email: "a@rcr.example", is_company: true, vat: false, street: "Rue D 4", zip: "1000", city: "Brussels", country_code: "BE", type: "contact", parent_id: false, active: true, x_room_credit_hours: 3, x_room_credit_rooms: false };
  partners[7].parent_id = [127, "RCR ASBL"];
  await withWebsite(odoo, async () => {
    _setWebsiteDeps({ conflicts: async () => [], member: async () => member as never, settings: async () => settings, products: async () => ROOMS, balance: async () => 7, email: () => "xavier@example.org", dm: async () => {}, odoo: () => odoo, events: async () => [{ description: "Room credits: 2 h (organisation 127)" }] });
    const start = new Date(Date.UTC(2030, 0, 8, 8, 0));
    const a = await (await post("availability", { room: "satoshi", start: start.toISOString(), end: new Date(start.getTime() + 2 * 3600000).toISOString(), org: "127" })).json();
    expect(a.credits).toMatchObject({ organisation: "RCR ASBL", perWeek: 3, left: 1, covered: 1, overflow: 1, eur: { untaxed: 42 } });
    const none = await (await post("availability", { room: "satoshi", start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString() })).json();
    expect(none.credits).toBeUndefined();
  });
});

Deno.test("emailUser: not a member, so no member price", async () => {
  const { odoo, partners } = fakeOdoo();
  partners[1276] = { id: 1276, name: "Barbara", email: "barbara@donut.example", is_company: false, vat: false, street: false, zip: false, city: false, country_code: false, type: "contact", parent_id: false, active: true };
  await withWebsite(odoo, async () => {
    const as = (endpoint: string, body: Record<string, unknown>) => post(endpoint, { userId: undefined, emailUser: { email: "barbara@donut.example" }, ...body });
    const o = await (await as("options", {})).json();
    expect(o).toMatchObject({ eurOnly: true, eur: { memberDiscount: 0 } });
    const start = new Date(Date.UTC(2030, 0, 8, 8, 0));
    const a = await (await as("availability", { room: "satoshi", start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString() })).json();
    expect(a.eur).toMatchObject({ untaxed: 60, total: 72.6 });
  });
});

// ── Linking Discord and email ───────────────────────────────────────────────

import { linkAccount } from "../src/lib/account-link.ts";
import { getUserEmail } from "../src/lib/user-emails.ts";

Deno.test("link: the bot remembers the email, the Odoo contact gets the Discord account; none is created", async () => {
  await withDataDir(async () => {
    const { odoo, partners, calls } = fakeOdoo();
    partners[1276] = { id: 1276, name: "Barbara", email: "barbara@donut.example", is_company: false, type: "contact", parent_id: false, active: true };
    const r = await linkAccount(odoo, { guildId: GUILD, discordId: "555555555555", username: "barb.", email: "Barbara@donut.example" });
    expect(r).toEqual({ ok: true, partnerId: 1276 });
    expect(partners[1276]).toMatchObject({ x_discord_id: "555555555555", x_discord_username: "barb." });
    expect(getUserEmail(GUILD, "555555555555")).toBe("barbara@donut.example");
    // Nobody in Odoo with that address: the bot still remembers it, nothing created.
    expect(await linkAccount(odoo, { guildId: GUILD, discordId: "666666666666", username: "x", email: "new@example.org" })).toEqual({ ok: true, partnerId: null });
    expect(calls.some((c) => c.method === "create")).toBe(false);
    expect(await linkAccount(odoo, { guildId: GUILD, discordId: "nope", username: "x", email: "a@b.example" })).toMatchObject({ ok: false, status: 400 });
  });
});

Deno.test("account: what's left to link, for someone on Discord and someone signed in by email", async () => {
  const { odoo, partners } = fakeOdoo();
  partners[1276] = { id: 1276, name: "Barbara", email: "barbara@donut.example", is_company: false, vat: false, street: false, zip: false, city: false, country_code: false, type: "contact", parent_id: false, active: true };
  await withWebsite(odoo, async () => {
    expect(await (await post("account", {})).json()).toMatchObject({ ok: true, hasEmail: true, discordLinked: true });
    const asBarbara = () => post("account", { userId: undefined, emailUser: { email: "barbara@donut.example" } });
    expect(await (await asBarbara()).json()).toMatchObject({ hasEmail: true, discordLinked: false });
    partners[1276].x_discord_id = "555555555555";
    expect(await (await asBarbara()).json()).toMatchObject({ discordLinked: true });
  });
});

// ── Unlimited coworking (monthly subscription) ─────────────────────────────

function withSubscriptions() {
  const base = fakeOdoo();
  const orders: Record<string, unknown>[] = [];
  const odoo: OdooCall = async (model, method, args = {}) => {
    base.calls.push({ model, method, args });
    if (model === "sale.order") {
      if (method === "search_read") {
        const [, , [, , partnerIds]] = args.domain as [unknown, unknown, [string, string, number[]]];
        return orders.filter((o) => o.state === "sale" && partnerIds.includes(o.partner_id as number)).map((o) => ({ id: o.id, name: o.name, start_date: o.start_date, next_invoice_date: "2030-02-08", amount_untaxed: ((o.order_line as unknown[][])[0][2] as { price_unit: number }).price_unit, plan_id: o.plan_id === 2 ? [2, "Yearly"] : [1, "Monthly"] }));
      }
      if (method === "create") {
        const v = (args.vals_list as Record<string, unknown>[])[0];
        const id = 300 + orders.length;
        orders.push({ ...v, id, name: `S00${id}`, state: "draft" });
        return [id];
      }
      if (method === "action_confirm") {
        for (const o of orders) if ((args.ids as number[]).includes(o.id as number)) o.state = "sale";
        return true;
      }
      if (method === "read") return [{ invoice_ids: [900] }];
    }
    if (model === "sale.advance.payment.inv") return method === "create" ? [1] : true;
    if (model === "account.move" && method === "read" && (args.fields as string[]).length === 1) return [{ state: "draft" }];
    return base.odoo(model, method, args);
  };
  return { ...base, odoo, orders };
}

Deno.test("unlimited coworking: a monthly subscription in Odoo, the first month invoiced; only one", async () => {
  await withDataDir(async () => {
    const { odoo, calls, orders } = withSubscriptions();
    const { subscribeCowork, myCoworkSubscription } = await import("../src/lib/cowork-subscription.ts");
    expect(await myCoworkSubscription(odoo, "xavier@example.org")).toBe(null);
    const r = await subscribeCowork(odoo, { guildId: GUILD, userId: USER, member: { name: "Xavier", email: "xavier@example.org" }, to: "self", today: "2030-01-08" });
    expect(r).toMatchObject({ ok: true, subscription: { name: "S00300", since: "2030-01-08" }, invoice: { number: "2026_RCC_0105" } });
    expect(orders[0]).toMatchObject({ partner_id: 7, partner_invoice_id: 7, plan_id: 1, journal_id: 11, state: "sale" });
    expect((orders[0].order_line as unknown[][])[0][2]).toMatchObject({ product_id: 289, price_unit: 100, tax_ids: [[6, 0, [163]]] });
    expect(calls.some((c) => c.model === "account.move" && c.method === "action_post")).toBe(true);
    expect(await myCoworkSubscription(odoo, "xavier@example.org")).toMatchObject({ name: "S00300" });
    expect(await subscribeCowork(odoo, { guildId: GUILD, userId: USER, member: { name: "Xavier", email: "xavier@example.org" }, to: "self" })).toMatchObject({ ok: false, status: 409 });
    expect(await subscribeCowork(odoo, { guildId: GUILD, userId: USER, member: { name: "Xavier" }, to: "self" })).toMatchObject({ ok: false, status: 400 });
  });
});

Deno.test("unlimited coworking: a year at once, €1,000 on the Yearly plan", async () => {
  await withDataDir(async () => {
    const { odoo, orders } = withSubscriptions();
    const { subscribeCowork } = await import("../src/lib/cowork-subscription.ts");
    const r = await subscribeCowork(odoo, { guildId: GUILD, userId: USER, member: { name: "Xavier", email: "xavier@example.org" }, to: "self", period: "year", today: "2030-01-08" });
    expect(r).toMatchObject({ ok: true, subscription: { period: "year", amount: 1000 } });
    expect(orders[0]).toMatchObject({ plan_id: 2 });
    expect((orders[0].order_line as unknown[][])[0][2]).toMatchObject({ price_unit: 1000 });
  });
});

Deno.test("unlimited coworking: the website endpoints", async () => {
  const { odoo } = withSubscriptions();
  await withWebsite(odoo, async () => {
    const o = await (await post("options", {})).json();
    expect(o.eur.coworkMonthly).toMatchObject({ untaxed: 100, vat: 21, total: 121 });
    expect(o.eur.coworkYearly).toMatchObject({ untaxed: 1000, vat: 210, total: 1210 });
    expect((await (await post("account", {})).json()).coworkSubscription).toBe(null);
    expect((await post("subscribecowork", { org: "self", pay: "later" })).status).toBe(400);
    expect((await post("subscribecowork", { org: "self", pay: "card", period: "year" })).status).toBe(400);
    const r = await (await post("subscribecowork", { org: "self", pay: "card" })).json();
    expect(r).toMatchObject({ ok: true, subscription: { name: "S00300" }, invoice: { total: 50.82 } });
    expect((await (await post("account", {})).json()).coworkSubscription).toMatchObject({ name: "S00300", monthly: 100, period: "month" });
  });
});
