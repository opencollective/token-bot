/**
 * /guestpass and propose_guest_pass: prices, start times, the signed door link and its exact
 * window, the purchase order (link before charge), the guest's email, and the record.
 */
import { expect } from "@std/expect/expect";
import { verifyMessage, Wallet } from "ethers";
import commands from "../src/commands.json" with { type: "json" };
import {
  _setGuestPassDeps,
  buildGuestPassLink,
  DOOR_GRACE_MINUTES,
  executeGuestPass,
  GUEST_PASSES,
  guestLabel,
  guestPassItem,
  linkMessage,
  normalizeEmail,
  parseStart,
  PASS_DISCLAIMER,
  passCost,
  passPageUrl,
  passWindow,
  whenLabel,
  zonedTime,
} from "../src/lib/guest-pass.ts";
import { buildGuestPassEmail } from "../src/lib/guest-pass-email.ts";
import { findShopItem } from "../src/lib/shop.ts";
import { COWORKING_TOKEN_TERMS } from "../src/lib/token-terms.ts";
import { getMcpTools } from "../src/mcp/server.ts";
import type { GuildSettings, Token } from "../src/types.ts";

const CHT = { name: "Commons Hub Token", symbol: "CHT", decimals: 6, chain: "celo", address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d", mintable: true } as Token;
const settings = { guild: { id: "g", name: "G" }, channels: {}, tokens: [CHT] } as unknown as GuildSettings;
const HASH = "0x" + "cd".repeat(32);

Deno.test("prices follow contributor coworking: half day (5h) like a half day, full day (10h) like a day; coworking terms", () => {
  expect(GUEST_PASSES["half-day"].price).toBe(findShopItem("coworking-half-day")!.price);
  expect(GUEST_PASSES["half-day"].price).toBe(1);
  expect(GUEST_PASSES["half-day"].hours).toBe(5);
  expect(GUEST_PASSES.day.price).toBe(findShopItem("coworking-day")!.price);
  expect(GUEST_PASSES.day.hours).toBe(10);
  for (const p of Object.values(GUEST_PASSES)) {
    expect(p.category).toBe("coworking");
    expect(p.terms).toBe(COWORKING_TOKEN_TERMS);
  }
  expect(guestPassItem(undefined)?.length).toBe("half-day");
  expect(guestPassItem("full day")?.length).toBe("day");
  expect(guestPassItem("week")).toBeUndefined();
});

Deno.test("guest label: \"Xavier's guest\", or \"Leo (Xavier's guest)\"; markup stripped", () => {
  expect(guestLabel("Xavier")).toBe("Xavier's guest");
  expect(guestLabel("Xavier", "Leo")).toBe("Leo (Xavier's guest)");
  expect(guestLabel("Xavier", " <@123> & co ")).toBe("123 co (Xavier's guest)");
  expect(normalizeEmail("")).toBeUndefined();
  expect(normalizeEmail(" leo@example.org ")).toBe("leo@example.org");
  expect(normalizeEmail("leo@")).toBeNull();
});

Deno.test("start times are Brussels time; past and far-future starts are refused", () => {
  const now = new Date("2026-10-22T08:00:00Z"); // 10:00 in Brussels (CEST)
  const at = (s: string) => {
    const r = parseStart(s, now);
    if ("error" in r) throw new Error(r.error);
    return r.start.toISOString();
  };
  expect(at("")).toBe(now.toISOString());
  expect(at("14:00")).toBe("2026-10-22T12:00:00.000Z");
  expect(at("2pm")).toBe("2026-10-22T12:00:00.000Z");
  expect(at("14h30")).toBe("2026-10-22T12:30:00.000Z");
  expect(at("tomorrow 9:00")).toBe("2026-10-23T07:00:00.000Z");
  expect(at("26/10 9:30")).toBe("2026-10-26T08:30:00.000Z"); // after the switch to winter time (CET)
  expect(at("2026-10-24 09:00")).toBe("2026-10-24T07:00:00.000Z");
  expect(at("2026-10-24T09:00:00+02:00")).toBe("2026-10-24T07:00:00.000Z");
  expect(at("9:50")).toBe(now.toISOString()); // a few minutes ago: now
  expect("error" in parseStart("8:00", now)).toBe(true);
  expect("error" in parseStart("2/11 9:00", now)).toBe(true); // more than 7 days ahead
  expect("error" in parseStart("whenever", now)).toBe(true);
  expect(zonedTime(2026, 1, 15, 9, 0).toISOString()).toBe("2026-01-15T08:00:00.000Z");
});

/** What the door server does with the query (server/index.js verifyEventOrganizerSignature). */
function door(url: string, at: Date): { signer: string; open: boolean } {
  const q = Object.fromEntries(new URL(url).searchParams);
  const message = `name=${q.name}&host=${q.host}&reason=${q.reason}&timestamp=${q.timestamp}&startTime=${q.startTime}&duration=${q.duration}${q.booking === "1" ? "&booking=1" : ""}`;
  const start = +q.startTime, end = start + +q.duration * 60, now = at.getTime() / 1000;
  return { signer: verifyMessage(message, q.sig), open: now >= start - 30 * 60 && now <= end + 30 * 60 };
}

Deno.test("the door link verifies like the door server does and opens exactly during the pass", async () => {
  const w = Wallet.createRandom();
  const { start, end } = passWindow(new Date("2026-10-22T07:00:00Z"), GUEST_PASSES["half-day"]);
  const url = (await buildGuestPassLink({ guest: "Leo (Xavier's guest)", host: "Xavier", start, end }, w.privateKey))!;
  expect(door(url, start).signer).toBe(w.address);
  const q = new URL(url).searchParams;
  expect(q.get("name")).toBe("Leo (Xavier's guest)");
  expect(q.get("booking")).toBe("1");
  expect(q.get("reason")).toBe("a guest pass (9am-2pm)");
  const min = 60000;
  expect(door(url, new Date(start.getTime() - min)).open).toBe(false);
  expect(door(url, start).open).toBe(true);
  expect(door(url, end).open).toBe(true);
  expect(door(url, new Date(end.getTime() + min)).open).toBe(false);
  expect(DOOR_GRACE_MINUTES).toBe(30);
  expect(await buildGuestPassLink({ guest: "x", host: "y", start, end }, undefined)).toBeNull();
});

function fakes(over: { link?: string | null; purchaseOk?: boolean; emailFails?: boolean } = {}) {
  const calls = { purchase: [] as any[], email: [] as any[], record: [] as any[] };
  _setGuestPassDeps({
    link: () => Promise.resolve(over.link === undefined ? "https://door.commonshub.brussels/open?sig=x" : over.link),
    purchase: (p) => {
      calls.purchase.push(p);
      return Promise.resolve(over.purchaseOk === false ? { ok: false, error: "Not enough tokens" } : { ok: true, hash: HASH, txUri: `celo:${HASH}`, balanceAfter: 4 });
    },
    email: (d) => {
      calls.email.push(d);
      return over.emailFails ? Promise.reject(new Error("Resend 500")) : Promise.resolve({ id: "e" });
    },
    record: (r) => {
      calls.record.push(r);
      return Promise.resolve();
    },
  });
  return calls;
}

const request = (extra: Record<string, unknown> = {}) => ({
  client: {} as never,
  guildId: "g",
  guildSettings: settings,
  token: CHT,
  item: GUEST_PASSES["half-day"],
  buyer: { id: "111", name: "Xavier", email: "xavier@example.org" },
  start: new Date("2026-10-22T07:00:00Z"),
  via: "command" as const,
  ...extra,
});

Deno.test("no door key: nothing is charged", async () => {
  const calls = fakes({ link: null });
  const r = await executeGuestPass(request());
  expect(r.ok).toBe(false);
  expect(calls.purchase.length).toBe(0);
  _setGuestPassDeps();
});

Deno.test("a pass burns the price like a coworking purchase; the guest's name and email stay out of the public record", async () => {
  const calls = fakes();
  const r = await executeGuestPass(request({ guestName: "Leo", guestEmail: "leo@example.org" }));
  expect(r.ok).toBe(true);
  expect(calls.purchase.length).toBe(1);
  const p = calls.purchase[0];
  expect(p.item.price).toBe(1);
  expect(p.item.category).toBe("coworking");
  expect(p.buyer).toEqual({ id: "111", name: "Xavier" });
  expect(p.description).not.toContain("Leo");
  expect(p.description).not.toContain("@");
  expect(calls.email[0]).toMatchObject({ guestName: "Leo", guestEmail: "leo@example.org", hostName: "Xavier", hostEmail: "xavier@example.org", length: "half-day" });
  expect(calls.record[0]).toMatchObject({ guest: "Leo (Xavier's guest)", guestEmail: "leo@example.org", txHash: HASH, emailed: true, price: 1 });
  if (r.ok) {
    expect(r.end.getTime() - r.start.getTime()).toBe(5 * 3600000);
    const text = linkMessage(r, GUEST_PASSES["half-day"], new Date("2026-10-22T06:00:00Z"));
    expect(text).toContain("https://commonshub.brussels/pass#sig=x&pass=half-day");
    expect(text).not.toContain("door.commonshub.brussels/open");
    expect(calls.email[0].passUrl).toBe("https://commonshub.brussels/pass#sig=x&pass=half-day");
    expect(calls.email[0].cost).toBe("Half day: €15 (+ VAT) or 1 token");
    expect(text).toContain("today, 09:00–14:00");
    expect(text).toContain("emailed");
  }
  _setGuestPassDeps();
});

Deno.test("a failed payment sends no email; a failed email keeps the pass and says so", async () => {
  let calls = fakes({ purchaseOk: false });
  expect((await executeGuestPass(request({ guestEmail: "leo@example.org" }))).ok).toBe(false);
  expect(calls.email.length).toBe(0);
  expect(calls.record.length).toBe(0);
  calls = fakes({ emailFails: true });
  const r = await executeGuestPass(request({ guestEmail: "leo@example.org" }));
  expect(r.ok).toBe(true);
  if (r.ok) expect(linkMessage(r, GUEST_PASSES["half-day"])).toContain("send them the link yourself");
  expect(calls.record[0].emailed).toBe(false);
  _setGuestPassDeps();
});

Deno.test("the guest's email: who invited them, when, the door button, the coworking terms", () => {
  const { subject, html, text } = buildGuestPassEmail({
    guestName: "Leo",
    guestEmail: "leo@example.org",
    hostName: "Xavier",
    hostEmail: "xavier@example.org",
    start: new Date("2026-10-23T07:00:00Z"),
    end: new Date("2026-10-23T12:00:00Z"),
    doorLink: "https://door.commonshub.brussels/open?a=1&sig=2",
    passUrl: "https://commonshub.brussels/pass#a=1&sig=2&pass=half-day",
    length: "half-day",
    cost: passCost(GUEST_PASSES["half-day"]),
  });
  expect(subject).toBe("Xavier invited you to the Commons Hub: Friday 23 October");
  expect(html).toContain("Hi Leo, you're invited");
  expect(html).toContain('href="https://door.commonshub.brussels/open?a=1&amp;sig=2"');
  expect(text).toContain("It works Friday 23 October, 09:00–14:00, and only then.");
  expect(text).not.toContain(COWORKING_TOKEN_TERMS); // Xavier: no token terms paragraph in the guest's email
  expect(html).not.toContain(COWORKING_TOKEN_TERMS);
  expect(text).toContain("Cost: Half day: €15 (+ VAT) or 1 token, paid by Xavier");
  expect(html).toMatch(/<td align="center">\s*<a href="https:\/\/door\.commonshub\.brussels\/open\?a=1&amp;sig=2"/); // centered button
  expect(text).toContain("Your pass: https://commonshub.brussels/pass#a=1&sig=2&pass=half-day");
  expect(text).toContain(PASS_DISCLAIMER);
  expect(text).toContain("(xavier@example.org, in cc)");
});

Deno.test("/guestpass and propose_guest_pass are declared, with the coworking terms for Elinor", () => {
  const cmd = (commands as { name: string; options?: { name: string; choices?: { value: string }[] }[] }[]).find((c) => c.name === "guestpass")!;
  expect(cmd.options!.map((o) => o.name)).toEqual(["length", "start", "guest_name", "guest_email"]);
  expect(cmd.options![0].choices!.map((c) => c.value)).toEqual(["half-day", "day"]);
  const tool = getMcpTools({ checkUserPermissions: async () => ({}), proposeGuestPass: async () => ({}) }).find((t) => t.name === "propose_guest_pass")!;
  expect(tool.description).toContain(COWORKING_TOKEN_TERMS);
  expect(tool.description).toContain("never returned to you");
  expect(whenLabel(new Date("2026-10-24T07:00:00Z"), new Date("2026-10-24T17:00:00Z"), new Date("2026-10-22T08:00:00Z"))).toBe("Sat 24 Oct, 09:00–19:00");
});

Deno.test("the pass page link carries the signed door-link parameters in the fragment, plus the length", () => {
  const door = "https://door.commonshub.brussels/open?name=Leo+%28Xavier%27s+guest%29&host=Xavier&startTime=1&duration=240&booking=1&sig=0xab";
  const page = passPageUrl(door, "day");
  expect(page.startsWith("https://commonshub.brussels/pass#")).toBe(true);
  const q = new URLSearchParams(page.split("#")[1]);
  expect(q.get("name")).toBe("Leo (Xavier's guest)");
  expect(q.get("sig")).toBe("0xab");
  expect(q.get("pass")).toBe("day");
  expect(passCost(GUEST_PASSES.day)).toBe("Full day: €25 (+ VAT) or 2 tokens");
});
