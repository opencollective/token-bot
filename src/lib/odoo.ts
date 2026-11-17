/**
 * A small client for Odoo's JSON-2 API (Odoo ≥ 19): POST /json/2/<model>/<method> with named
 * arguments, authenticated with an API key (Bearer) and the database in X-Odoo-Database.
 *
 * Configured with ODOO_URL (https://commonshub.odoo.com), ODOO_DB and ODOO_API_KEY (the key of a
 * dedicated API user, limited to what invoicing needs). Without them, euro payments are off.
 */
import { getEnv } from "./utils.ts";

export type OdooCall = (model: string, method: string, args?: Record<string, unknown>) => Promise<unknown>;

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
  const url = (getEnv("ODOO_URL") || "").replace(/\/$/, "");
  const db = getEnv("ODOO_DB") || "";
  const key = getEnv("ODOO_API_KEY") || "";
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
