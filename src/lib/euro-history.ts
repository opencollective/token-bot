/**
 * A person's euro transactions with the hub, for their website dashboard: the invoices they paid
 * (or were refunded) in Odoo, and their membership payments on Stripe (subscription invoices: card
 * payments for Odoo invoices are already counted as the invoice). From their side: a payment to the
 * hub is negative, a refund positive. Person-level only: what their organisations paid isn't here.
 */

import { likeLiteral, type OdooCall } from "./odoo.ts";
import { getEnv } from "./utils.ts";

export type EuroTx = { at: string; amount: number; description: string };

const MAX = 50;
const firstLine = (s: unknown) => (typeof s === "string" ? s.split("\n")[0].trim().slice(0, 140) : "");

/** Their own contacts: every person contact with that email, and the one linked to their Discord account. */
export async function personContacts(odoo: OdooCall, p: { email?: string; discordId?: string }): Promise<number[]> {
  const ids = new Set<number>();
  const email = p.email?.trim().toLowerCase();
  if (email) {
    const found = (await odoo("res.partner", "search_read", { domain: [["email", "=ilike", likeLiteral(email)], ["is_company", "=", false]], fields: ["id", "email"], limit: 10 })) as { id: number; email: string | false }[];
    for (const c of found) if (typeof c.email === "string" && c.email.trim().toLowerCase() === email) ids.add(c.id);
  }
  if (p.discordId) {
    const linked = (await odoo("res.partner", "search_read", { domain: [["x_discord_id", "=", p.discordId]], fields: ["id"], limit: 5 })) as { id: number }[];
    for (const c of linked) ids.add(c.id);
  }
  return [...ids];
}

/** Paid (or partly paid) customer invoices and refunds of those contacts, newest first. */
export async function odooHistory(odoo: OdooCall, partnerIds: number[]): Promise<EuroTx[]> {
  if (!partnerIds.length) return [];
  const moves = (await odoo("account.move", "search_read", {
    domain: [["partner_id", "child_of", partnerIds], ["move_type", "in", ["out_invoice", "out_refund"]], ["state", "=", "posted"], ["payment_state", "in", ["paid", "in_payment", "partial", "reversed"]]],
    fields: ["id", "name", "invoice_date", "amount_total_signed", "move_type", "invoice_origin"],
    order: "invoice_date desc, id desc",
    limit: MAX,
  })) as { id: number; name: string; invoice_date: string | false; amount_total_signed: number; move_type: string; invoice_origin: string | false }[];
  if (!moves.length) return [];
  const lines = (await odoo("account.move.line", "search_read", {
    domain: [["move_id", "in", moves.map((m) => m.id)], ["display_type", "=", "product"]],
    fields: ["move_id", "name"],
    order: "id asc",
  })) as { move_id: [number, string] | false; name: string | false }[];
  const label = new Map<number, string>();
  for (const l of lines) if (l.move_id && !label.has(l.move_id[0]) && firstLine(l.name)) label.set(l.move_id[0], firstLine(l.name));
  return moves
    .filter((m) => m.invoice_date)
    .map((m) => ({
      at: `${m.invoice_date}T12:00:00Z`,
      // amount_total_signed is the hub's side (an invoice positive, a refund negative).
      amount: -Math.round(m.amount_total_signed * 100) / 100,
      description: `${label.get(m.id) || (m.move_type === "out_refund" ? "Refund" : "Invoice")} (${m.name})`,
    }));
}

type StripeList<T> = { data: T[] };
type StripeInvoice = { id: string; number: string | null; amount_paid: number; status: string; created: number; status_transitions?: { paid_at?: number | null }; lines?: { data?: Array<{ description?: string | null }> } };

/** Their membership payments on Stripe, by the customers with that email. */
export async function stripeHistory(email: string | undefined, fetcher: typeof fetch = fetch): Promise<EuroTx[]> {
  const key = getEnv("STRIPE_SECRET_KEY");
  const address = email?.trim().toLowerCase();
  if (!key || !address) return [];
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetcher(`https://api.stripe.com/v1${path}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`Stripe ${r.status}`);
    return (await r.json()) as T;
  };
  const customers = await get<StripeList<{ id: string }>>(`/customers?email=${encodeURIComponent(address)}&limit=10`);
  const out: EuroTx[] = [];
  for (const c of customers.data) {
    const invoices = await get<StripeList<StripeInvoice>>(`/invoices?customer=${c.id}&status=paid&limit=${MAX}`);
    for (const i of invoices.data) {
      if (i.amount_paid <= 0) continue;
      const at = new Date(((i.status_transitions?.paid_at ?? i.created) || i.created) * 1000).toISOString();
      const what = firstLine(i.lines?.data?.[0]?.description) || "Membership";
      out.push({ at, amount: -i.amount_paid / 100, description: what });
    }
  }
  return out;
}

/** Both, newest first, at most 50. */
export async function euroHistory(odoo: OdooCall | null, p: { email?: string; discordId?: string; stripe: boolean }): Promise<EuroTx[]> {
  const [fromOdoo, fromStripe] = await Promise.all([
    odoo ? personContacts(odoo, p).then((ids) => odooHistory(odoo, ids)).catch((e) => (console.error("[euro-history] odoo:", e), [] as EuroTx[])) : Promise.resolve([] as EuroTx[]),
    p.stripe ? stripeHistory(p.email).catch((e) => (console.error("[euro-history] stripe:", e), [] as EuroTx[])) : Promise.resolve([] as EuroTx[]),
  ]);
  return [...fromOdoo, ...fromStripe].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX);
}
