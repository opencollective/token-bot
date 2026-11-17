/**
 * A small client for Odoo's JSON-2 API (Odoo ≥ 19): POST /json/2/<model>/<method> with named
 * arguments, authenticated with an API key (Bearer) and the database in X-Odoo-Database.
 *
 * Configured with ODOO_URL (https://commonshub.odoo.com), ODOO_DB and ODOO_API_KEY (the key of a
 * dedicated API user, limited to what invoicing needs). Without them, euro payments are off.
 */
import { getEnv } from "./utils.ts";

export type OdooCall = (model: string, method: string, args?: Record<string, unknown>) => Promise<unknown>;

/** `=ilike` in Odoo is SQL ILIKE: % and _ in a value (an email address) must not act as wildcards. */
export const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function odooConfigured(): boolean {
  return !!(getEnv("ODOO_URL") && getEnv("ODOO_DB") && getEnv("ODOO_API_KEY"));
}

export class OdooError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The JSON-2 caller for the configured database. */
export function odooFromEnv(fetcher: typeof fetch = fetch): OdooCall {
  return odooCaller((getEnv("ODOO_URL") || "").replace(/\/$/, ""), getEnv("ODOO_DB") || "", getEnv("ODOO_API_KEY") || "", fetcher);
}

function odooCaller(url: string, db: string, key: string, fetcher: typeof fetch): OdooCall {
  return async (model, method, args = {}) => {
    if (!url || !db || !key) throw new OdooError("Odoo is not configured", 503);
    const res = await fetcher(`${url}/json/2/${model}/${method}`, {
      method: "POST",
      headers: { Authorization: `bearer ${key}`, "X-Odoo-Database": db, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch { /* not JSON */ }
    if (!res.ok) {
      const message = (body as { message?: string } | null)?.message || text.slice(0, 200) || res.statusText;
      throw new OdooError(`Odoo ${model}.${method}: ${message}`, res.status);
    }
    return body;
  };
}

// ── Test users ──────────────────────────────────────────────────────────────
//
// Addresses in TEST_LOGIN_EMAILS (comma separated) sign in to the website as test users: everything
// they do in euros goes to a test copy of Odoo (ODOO_TEST_URL, ODOO_TEST_DB; ODOO_TEST_API_KEY, or
// ODOO_API_KEY since a copy of the database keeps the same users and keys) and the website takes
// their card payments with Stripe's sandbox. The test database must be a neutralized copy (Odoo's
// own flag for duplicates: no outgoing mail, no crons): if it isn't, nothing is done in it.

export function testLoginEmails(): Set<string> {
  return new Set((getEnv("TEST_LOGIN_EMAILS") || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}
export const isTestEmail = (email: string | null | undefined) => !!email && testLoginEmails().has(email.trim().toLowerCase());

export function odooTestConfigured(): boolean {
  return !!(getEnv("ODOO_TEST_URL") && getEnv("ODOO_TEST_DB") && (getEnv("ODOO_TEST_API_KEY") || getEnv("ODOO_API_KEY")));
}

let neutralizedCheck: { key: string; at: number; ok: boolean } | null = null;
const NEUTRALIZED_TTL_MS = 10 * 60_000;

/** The test database's JSON-2 caller; every call first makes sure (cached 10 min) it's a neutralized copy, not production. */
export function odooTestFromEnv(fetcher: typeof fetch = fetch, now: () => number = Date.now): OdooCall {
  const url = (getEnv("ODOO_TEST_URL") || "").replace(/\/$/, "");
  const db = getEnv("ODOO_TEST_DB") || "";
  const key = getEnv("ODOO_TEST_API_KEY") || getEnv("ODOO_API_KEY") || "";
  const raw = odooCaller(url, db, key, fetcher);
  return async (model, method, args = {}) => {
    if (url === (getEnv("ODOO_URL") || "").replace(/\/$/, "") && db === getEnv("ODOO_DB")) throw new OdooError("The test Odoo database is the production one", 503);
    const id = `${url}|${db}`;
    if (!neutralizedCheck || neutralizedCheck.key !== id || now() - neutralizedCheck.at > NEUTRALIZED_TTL_MS) {
      const flag = await raw("ir.config_parameter", "get_param", { key: "database.is_neutralized" }).catch(() => null);
      neutralizedCheck = { key: id, at: now(), ok: flag === true || flag === "true" || flag === "True" };
    }
    if (!neutralizedCheck.ok) throw new OdooError(`The test Odoo database (${db}) is not a neutralized copy: refusing to use it`, 503);
    return raw(model, method, args);
  };
}
/** For tests. */
export const _resetNeutralizedCheck = () => void (neutralizedCheck = null);
