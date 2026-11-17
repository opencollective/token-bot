/**
 * Signing in with an email address: a code only for addresses Odoo knows (same answer otherwise),
 * one use, 10 minutes, 5 tries, rate limits, wildcards in addresses taken literally.
 */
import { expect } from "@std/expect/expect";
import { _setLoginDeps, MAX_ATTEMPTS, partnerByEmail, requestCode, verifyCode } from "../src/lib/email-login.ts";
import { likeLiteral, type OdooCall } from "../src/lib/odoo.ts";
import { handleWebsiteRequest } from "../src/lib/website-api.ts";

const PARTNERS = [
  { id: 7, name: "Xavier", email: "Xavier@Example.org", active: true },
  { id: 8, name: "Under Score", email: "a_b@example.org", active: true },
];
const domains: unknown[] = [];
const odoo: OdooCall = async (model, method, args = {}) => {
  if (model !== "res.partner" || method !== "search_read") throw new Error(`unexpected ${model}.${method}`);
  domains.push(args.domain);
  const [[, , pattern]] = args.domain as [string, string, string][];
  // ILIKE: % and _ are wildcards unless escaped.
  const re = new RegExp("^" + pattern.replace(/\\(.)|([%_])|([^\\%_]+)/g, (_m, esc, wild, lit) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : wild === "%" ? ".*" : wild === "_" ? "." : lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) + "$", "i");
  return PARTNERS.filter((p) => re.test(p.email));
};

function setup() {
  let now = 1_000_000;
  const mails: { to: string; code: string }[] = [];
  let next = 123456;
  _setLoginDeps({ odoo: () => odoo, send: async (to, code) => void mails.push({ to, code }), now: () => now, code: () => String(next++) });
  return { mails, advance: (ms: number) => (now += ms) };
}

Deno.test("a code for an address in Odoo, the same answer for one that isn't", async () => {
  const { mails } = setup();
  expect(await requestCode(" xavier@example.org ")).toEqual({ ok: true });
  expect(await requestCode("nobody@example.org")).toEqual({ ok: true });
  expect(mails).toEqual([{ to: "xavier@example.org", code: "123456" }]);
  expect(await requestCode("not an email")).toMatchObject({ ok: false, status: 400 });
});

Deno.test("the code signs in once, as the Odoo partner", async () => {
  setup();
  await requestCode("xavier@example.org");
  expect(await verifyCode("xavier@example.org", "000000")).toMatchObject({ ok: false, status: 401 });
  expect(await verifyCode("XAVIER@example.org", "123 456")).toEqual({ ok: true, partner: { id: 7, name: "Xavier", email: "xavier@example.org" } });
  expect(await verifyCode("xavier@example.org", "123456")).toMatchObject({ ok: false });
  expect(await verifyCode("nobody@example.org", "123456")).toMatchObject({ ok: false });
});

Deno.test("expires after 10 minutes and after 5 wrong tries", async () => {
  const { advance } = setup();
  await requestCode("xavier@example.org");
  advance(10 * 60_000 + 1);
  expect(await verifyCode("xavier@example.org", "123456")).toMatchObject({ ok: false });
  advance(60_000);
  await requestCode("xavier@example.org"); // 123457
  for (let i = 0; i < MAX_ATTEMPTS; i++) await verifyCode("xavier@example.org", "999999");
  expect(await verifyCode("xavier@example.org", "123457")).toMatchObject({ ok: false });
});

Deno.test("at most one code a minute and five an hour per address", async () => {
  const { advance, mails } = setup();
  expect(await requestCode("xavier@example.org")).toEqual({ ok: true });
  expect(await requestCode("xavier@example.org")).toMatchObject({ ok: false, status: 429 });
  for (let i = 0; i < 4; i++) {
    advance(61_000);
    expect(await requestCode("xavier@example.org")).toEqual({ ok: true });
  }
  advance(61_000);
  expect(await requestCode("xavier@example.org")).toMatchObject({ ok: false, status: 429 });
  expect(mails.length).toBe(5);
});

Deno.test("wildcards in an address are taken literally", async () => {
  setup();
  expect(likeLiteral("a_b%c\\d")).toBe("a\\_b\\%c\\\\d");
  expect(await partnerByEmail(odoo, "axb@example.org")).toBe(null);
  expect(await partnerByEmail(odoo, "a_b@example.org")).toMatchObject({ id: 8 });
  expect(await partnerByEmail(odoo, "%@example.org")).toBe(null);
});

Deno.test("routed under /api/website/login, with the website's token", async () => {
  setup();
  Deno.env.set("WEBSITE_API_TOKEN", "t".repeat(64));
  try {
    const call = (path: string, body: unknown, token = "t".repeat(64)) =>
      handleWebsiteRequest(new Request(`http://bot${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), path, null);
    expect((await call("/api/website/login/code", { email: "xavier@example.org" }, "x".repeat(64))).status).toBe(401);
    expect(await (await call("/api/website/login/code", { email: "xavier@example.org" })).json()).toEqual({ ok: true });
    expect(await (await call("/api/website/login/verify", { email: "xavier@example.org", code: "123456" })).json()).toEqual({ ok: true, partner: { id: 7, name: "Xavier", email: "xavier@example.org" } });
  } finally {
    Deno.env.delete("WEBSITE_API_TOKEN");
    _setLoginDeps();
  }
});
