/**
 * Signing in to commonshub.brussels with an email address: the website asks for a code, the bot
 * emails a 6-digit code if the address belongs to a partner in Odoo, the website sends the code
 * back and gets the partner (id, name, email) to open a session.
 *
 * The answer to a code request is the same whether or not Odoo knows the address (nobody can
 * probe who is in our books). A code lasts 10 minutes and allows 5 tries; an address gets a new
 * code at most once a minute and 5 times an hour. Codes are kept hashed, in memory: a restart
 * only means asking for a new one.
 *
 * POST /api/website/login/code {email} and /api/website/login/verify {email, code}, with the
 * website's bearer token like the other /api/website endpoints.
 */
import { getEnv } from "./utils.ts";
import { isTestEmail, likeLiteral, odooConfigured, odooFromEnv, odooTestConfigured, odooTestFromEnv, type OdooCall } from "./odoo.ts";

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const RESEND_AFTER_MS = 60_000;
export const MAX_PER_HOUR = 5;

type Pending = { hash: string; expires: number; attempts: number };
const pending = new Map<string, Pending>();
const sent = new Map<string, number[]>();

/** `test`: a test user (TEST_LOGIN_EMAILS), whose partner is in the test copy of Odoo. */
export type Partner = { id: number; name: string; email: string; test?: true };

type Deps = {
  odoo(): OdooCall | null;
  /** The test copy of Odoo, for test users (null when not configured). */
  testOdoo(): OdooCall | null;
  send(to: string, code: string): Promise<void>;
  now(): number;
  code(): string;
};

/** Six random digits. */
function randomCode(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

async function sendCode(to: string, code: string): Promise<void> {
  const apiKey = getEnv("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: getEnv("LOGIN_EMAIL_FROM") || "Commons Hub Brussels <hello@commonshub.brussels>",
      to: [to],
      subject: `${code} is your Commons Hub sign-in code`,
      text: `Your code to sign in to commonshub.brussels: ${code}\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.\n\nCommons Hub Brussels`,
      html: `<p>Your code to sign in to commonshub.brussels:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace">${code}</p><p>It works for 10 minutes. If you didn't ask for it, you can ignore this email.</p><p>Commons Hub Brussels</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const DEFAULT_DEPS: Deps = {
  odoo: () => (odooConfigured() ? odooFromEnv() : null),
  testOdoo: () => (odooTestConfigured() ? odooTestFromEnv() : null),
  send: sendCode,
  now: () => Date.now(),
  code: randomCode,
};
let deps: Deps = DEFAULT_DEPS;
/** For tests. */
export function _setLoginDeps(next?: Partial<Deps>) {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
  pending.clear();
  sent.clear();
}

export const normalizeLoginEmail = (raw: unknown): string | null => {
  const e = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return e.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
};

/** The active Odoo partner with exactly this email address, if any. */
export async function partnerByEmail(odoo: OdooCall, email: string): Promise<Partner | null> {
  const found = (await odoo("res.partner", "search_read", {
    domain: [["email", "=ilike", likeLiteral(email)], ["active", "=", true]],
    fields: ["id", "name", "email"],
    order: "is_company asc, id asc",
    limit: 5,
  })) as { id: number; name: string; email: string | false }[];
  const p = found.find((f) => typeof f.email === "string" && f.email.trim().toLowerCase() === email);
  return p ? { id: p.id, name: p.name, email } : null;
}

/** Which Odoo knows this address: the test copy for test users, production otherwise. */
const odooFor = (email: string) => (isTestEmail(email) ? deps.testOdoo() : deps.odoo());

/**
 * The partner to sign in as. A test user's partner is created in the test copy if it isn't there
 * (each fresh copy of the database starts without it).
 */
async function loginPartner(odoo: OdooCall, email: string): Promise<Partner | null> {
  const found = await partnerByEmail(odoo, email);
  if (!isTestEmail(email)) return found;
  if (found) return { ...found, test: true };
  const [id] = (await odoo("res.partner", "create", { vals_list: [{ name: "Test user", email, lang: "en_GB", comment: "Website test user (TEST_LOGIN_EMAILS), created by the bot." }] })) as number[];
  return { id, name: "Test user", email, test: true };
}

async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Result<T> = { ok: true } & T | { ok: false; error: string; status: number };

/** Email a code if Odoo knows the address. The same answer either way. */
export async function requestCode(rawEmail: unknown): Promise<Result<Record<never, never>>> {
  const email = normalizeLoginEmail(rawEmail);
  if (!email) return { ok: false, error: "That email address doesn't look valid.", status: 400 };
  const odoo = odooFor(email);
  if (!odoo) return { ok: false, error: "Signing in with an email address isn't available right now: use Discord.", status: 503 };
  const now = deps.now();
  const recent = (sent.get(email) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length && now - recent[recent.length - 1] < RESEND_AFTER_MS) return { ok: false, error: "We just sent you a code: wait a minute before asking for another.", status: 429 };
  if (recent.length >= MAX_PER_HOUR) return { ok: false, error: "Too many codes for this address: try again in an hour.", status: 429 };
  sent.set(email, [...recent, now]);

  const partner = await loginPartner(odoo, email);
  if (!partner) return { ok: true }; // nothing sent, nothing said
  const code = deps.code();
  pending.set(email, { hash: await sha256(`${email}:${code}`), expires: now + CODE_TTL_MS, attempts: 0 });
  try {
    await deps.send(email, code);
  } catch (error) {
    pending.delete(email);
    console.error("[email-login] could not send the code:", (error as Error)?.message || error);
    return { ok: false, error: "We couldn't send the email right now: try again in a moment, or use Discord.", status: 502 };
  }
  return { ok: true };
}

/** Check the code; on success the partner, and the code can't be used again. */
export async function verifyCode(rawEmail: unknown, rawCode: unknown): Promise<Result<{ partner: Partner }>> {
  const email = normalizeLoginEmail(rawEmail);
  const code = typeof rawCode === "string" ? rawCode.replace(/\s/g, "") : "";
  const wrong = { ok: false as const, error: "That code isn't right, or it has expired: ask for a new one.", status: 401 };
  if (!email || !/^\d{6}$/.test(code)) return wrong;
  const p = pending.get(email);
  if (!p) return wrong;
  if (deps.now() > p.expires || p.attempts >= MAX_ATTEMPTS) {
    pending.delete(email);
    return wrong;
  }
  p.attempts++;
  const hash = await sha256(`${email}:${code}`);
  let diff = hash.length ^ p.hash.length;
  for (let i = 0; i < Math.min(hash.length, p.hash.length); i++) diff |= hash.charCodeAt(i) ^ p.hash.charCodeAt(i);
  if (diff !== 0) return wrong;
  pending.delete(email);
  const odoo = odooFor(email);
  const partner = odoo ? await loginPartner(odoo, email) : null;
  if (!partner) return wrong; // removed from Odoo meanwhile
  return { ok: true, partner };
}

/** Route /api/website/login/{code,verify} (already authorized by the caller). */
export async function handleLogin(path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = path.endsWith("/code") ? await requestCode(body.email) : path.endsWith("/verify") ? await verifyCode(body.email, body.code) : { ok: false as const, error: "Not found", status: 404 };
  if (!r.ok) return { status: r.status, body: { ok: false, error: r.error } };
  const { ok: _ok, ...rest } = r;
  return { status: 200, body: { ok: true, ...rest } };
}
