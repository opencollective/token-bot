/**
 * Unlimited coworking: a subscription in Odoo (sale_subscription), €100 a month + VAT (by card), or
 * €1,000 a year + VAT (two months free, by bank transfer: the "Yearly" plan, ODOO_YEARLY_PLAN_ID, 2),
 * like the ones made by hand (S00221): product "Coworking" (ODOO_COWORK_PRODUCT_ID, 289), the
 * "Monthly" plan (ODOO_MONTHLY_PLAN_ID, 1), 21% services. Odoo invoices it every month and emails
 * the invoice; the first one is made at once and posted, which moves the next invoice to next month
 * (checked on Odoo 19), paid by card on the website or by transfer.
 *
 * Someone has unlimited coworking when Odoo has a running coworking subscription for their own
 * contact (any subscription with a coworking product, also the ones made by hand).
 */

import { likeLiteral, type OdooCall } from "./odoo.ts";
import { getEnv } from "./utils.ts";
import { billingChild, finishInvoice, type Invoice, invoicePartner, saleTax, salesJournal } from "./euro-billing.ts";

export const COWORK_MONTHLY_EUR = 100;
/** A year paid at once: two months free. */
export const COWORK_YEARLY_EUR = 1000;
export type CoworkPeriod = "month" | "year";
const productId = () => Number(getEnv("ODOO_COWORK_PRODUCT_ID")) || 289;
const planId = (period: CoworkPeriod) => period === "year" ? Number(getEnv("ODOO_YEARLY_PLAN_ID")) || 2 : Number(getEnv("ODOO_MONTHLY_PLAN_ID")) || 1;

/** `monthly`: what it costs a month before VAT (a yearly one, its amount / 12). */
export type CoworkSubscription = { id: number; name: string; since: string | null; nextInvoice: string | null; monthly: number; period: CoworkPeriod; amount: number };

/** Running (or paused) subscription with a coworking product, for one of these contacts. */
export async function coworkSubscriptionOf(odoo: OdooCall, partnerIds: number | number[]): Promise<CoworkSubscription | null> {
  const ids = Array.isArray(partnerIds) ? partnerIds : [partnerIds];
  if (!ids.length) return null;
  const found = (await odoo("sale.order", "search_read", {
    domain: [["is_subscription", "=", true], ["subscription_state", "in", ["3_progress", "4_paused"]], ["partner_id", "in", ids], ["order_line.product_id.name", "ilike", "cowork"]],
    fields: ["name", "start_date", "next_invoice_date", "amount_untaxed", "plan_id"],
    order: "start_date desc",
    limit: 1,
  })) as { id: number; name: string; start_date: string | false; next_invoice_date: string | false; amount_untaxed: number; plan_id: [number, string] | false }[];
  const s = found[0];
  if (!s) return null;
  const period: CoworkPeriod = s.plan_id && /year|annu/i.test(s.plan_id[1]) ? "year" : "month";
  return { id: s.id, name: s.name, since: s.start_date || null, nextInvoice: s.next_invoice_date || null, monthly: period === "year" ? Math.round((s.amount_untaxed / 12) * 100) / 100 : s.amount_untaxed, period, amount: s.amount_untaxed };
}

/**
 * The member's own subscription, found by their email: on any of their contacts with that address
 * (people often have one on their own and one under their organisation).
 */
export async function myCoworkSubscription(odoo: OdooCall, email: string | undefined): Promise<CoworkSubscription | null> {
  const address = email?.trim().toLowerCase();
  if (!address) return null;
  const people = (await odoo("res.partner", "search_read", { domain: [["email", "=ilike", likeLiteral(address)], ["is_company", "=", false]], fields: ["id", "email"], limit: 10 })) as { id: number; email: string | false }[];
  return await coworkSubscriptionOf(odoo, people.filter((p) => typeof p.email === "string" && p.email.trim().toLowerCase() === address).map((p) => p.id));
}

/**
 * Start one: for the member's own contact (created with their email when Odoo has none), invoiced
 * to them or one of their organisations. Confirmed at once, and its first month invoiced.
 */
export async function subscribeCowork(odoo: OdooCall, p: { guildId: string; userId: string; member: { name: string; email?: string }; to: number | "self"; period?: CoworkPeriod; today?: string }): Promise<{ ok: true; subscription: CoworkSubscription; invoice: Invoice | null } | { ok: false; error: string; status: number }> {
  if (!p.member.email) return { ok: false, error: "We need your email address for a subscription: add it on your dashboard first.", status: 400 };
  const self = await invoicePartner(odoo, { ...p, to: "self" });
  if (!self.ok) return self;
  const existing = (await myCoworkSubscription(odoo, p.member.email)) ?? (await coworkSubscriptionOf(odoo, self.partnerId));
  if (existing) return { ok: false, error: `You already have unlimited coworking (${existing.name}).`, status: 409 };
  const payer = p.to === "self" ? self : await invoicePartner(odoo, p);
  if (!payer.ok) return payer;
  const billing = await billingChild(odoo, payer.partnerId);
  const today = p.today ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Brussels" });
  const made = await createSubscription(odoo, { guildId: p.guildId, userId: p.userId, partnerId: self.partnerId, invoiceTo: billing?.id ?? payer.partnerId, payerId: payer.partnerId, period: p.period === "year" ? "year" : "month", start: today });
  return { ok: true, ...made };
}

/** Create, confirm and invoice (the first period, posted and emailed) a coworking subscription. */
async function createSubscription(odoo: OdooCall, p: { guildId: string; userId: string; partnerId: number; invoiceTo: number; payerId: number; period: CoworkPeriod; start: string; origin?: string }): Promise<{ subscription: CoworkSubscription; invoice: Invoice | null }> {
  const { period } = p;
  const price = period === "year" ? COWORK_YEARLY_EUR : COWORK_MONTHLY_EUR;
  const [orderId] = (await odoo("sale.order", "create", {
    vals_list: [{
      partner_id: p.partnerId,
      partner_invoice_id: p.invoiceTo,
      plan_id: planId(period),
      start_date: p.start,
      // Invoiced on the rental-coworking-catering journal, like the bookings (Odoo would pick "Memberships").
      journal_id: salesJournal(),
      origin: p.origin ?? "Website",
      order_line: [[0, 0, { product_id: productId(), name: period === "year" ? "Unlimited coworking (yearly, two months free)" : "Unlimited coworking (monthly)", product_uom_qty: 1, price_unit: price, tax_ids: [[6, 0, [saleTax()]]] }]],
    }],
  })) as number[];
  await odoo("sale.order", "action_confirm", { ids: [orderId] });
  // The first month (or the year), invoiced now (later periods: Odoo's subscription invoicing).
  let invoice: Invoice | null = null;
  try {
    const [wizard] = (await odoo("sale.advance.payment.inv", "create", { vals_list: [{ advance_payment_method: "delivered", sale_order_ids: [[6, 0, [orderId]]] }] })) as number[];
    await odoo("sale.advance.payment.inv", "create_invoices", { ids: [wizard] });
    const [order] = (await odoo("sale.order", "read", { ids: [orderId], fields: ["invoice_ids"] })) as { invoice_ids: number[] }[];
    const moveId = Math.max(...(order?.invoice_ids ?? []));
    if (Number.isFinite(moveId) && moveId > 0) {
      const [m] = (await odoo("account.move", "read", { ids: [moveId], fields: ["state"] })) as { state: string }[];
      if (m?.state === "draft") await odoo("account.move", "action_post", { ids: [moveId] });
      invoice = await finishInvoice(odoo, moveId, { guildId: p.guildId, userId: p.userId, partnerId: p.payerId });
    }
  } catch (error) {
    console.error("[cowork-subscription] the first invoice could not be made:", error);
  }
  const subscription = (await coworkSubscriptionOf(odoo, p.partnerId)) ?? { id: orderId, name: `S${orderId}`, since: p.start, nextInvoice: null, monthly: period === "year" ? price / 12 : price, period, amount: price };
  return { subscription, invoice };
}

/**
 * A monthly coworking subscription becomes a yearly one (€1,000 + VAT, two months free): its
 * unpaid invoices are credited (a credit note, posted, which settles them), it's closed, and a
 * yearly one starts where the unpaid period began (or at its next invoice), invoiced to the same
 * contact. A partly paid invoice: we don't guess, they write to us.
 */
export async function switchToYearly(odoo: OdooCall, p: { guildId: string; userId: string; email?: string; today?: string }): Promise<{ ok: true; subscription: CoworkSubscription; invoice: Invoice | null; credited: string[] } | { ok: false; error: string; status: number }> {
  const sub = await myCoworkSubscription(odoo, p.email);
  if (!sub) return { ok: false, error: "You don't have a coworking subscription.", status: 404 };
  if (sub.period === "year") return { ok: false, error: `${sub.name} is already yearly.`, status: 409 };
  const [order] = (await odoo("sale.order", "read", { ids: [sub.id], fields: ["partner_id", "partner_invoice_id", "next_invoice_date"] })) as { partner_id: [number, string]; partner_invoice_id: [number, string] | false; next_invoice_date: string | false }[];
  if (!order) return { ok: false, error: "We couldn't find your subscription.", status: 404 };
  const open = (await odoo("account.move", "search_read", {
    domain: [["invoice_origin", "=", sub.name], ["move_type", "=", "out_invoice"], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial", "in_payment"]]],
    fields: ["id", "name", "invoice_date", "payment_state"],
    order: "invoice_date asc",
  })) as { id: number; name: string; invoice_date: string | false; payment_state: string }[];
  if (open.some((m) => m.payment_state !== "not_paid")) return { ok: false, error: "Part of an invoice of your subscription is already paid: write to us and we'll switch it for you.", status: 409 };
  const today = p.today ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Brussels" });
  const start = open.find((m) => m.invoice_date)?.invoice_date || order.next_invoice_date || today;
  const credited: string[] = [];
  for (const m of open) {
    const [wizard] = (await odoo("account.move.reversal", "create", { vals_list: [{ move_ids: [[6, 0, [m.id]]], reason: "Switched to yearly coworking", journal_id: salesJournal() }] })) as number[];
    const action = (await odoo("account.move.reversal", "refund_moves", { ids: [wizard] })) as { res_id?: number } | null;
    const [inv] = (await odoo("account.move", "read", { ids: [m.id], fields: ["reversal_move_ids"] })) as { reversal_move_ids: number[] }[];
    const refundId = action?.res_id ?? Math.max(...(inv?.reversal_move_ids ?? []));
    if (Number.isFinite(refundId) && refundId > 0) {
      const [r] = (await odoo("account.move", "read", { ids: [refundId], fields: ["state"] })) as { state: string }[];
      if (r?.state === "draft") await odoo("account.move", "action_post", { ids: [refundId] });
    }
    credited.push(m.name);
  }
  await odoo("sale.order", "set_close", { ids: [sub.id] });
  const invoiceTo = order.partner_invoice_id ? order.partner_invoice_id[0] : order.partner_id[0];
  const made = await createSubscription(odoo, { guildId: p.guildId, userId: p.userId, partnerId: order.partner_id[0], invoiceTo, payerId: invoiceTo, period: "year", start, origin: `Website (from ${sub.name})` });
  return { ok: true, ...made, credited };
}

/** Their unpaid invoices (their own contacts), with the coworking subscription each comes from, if any. */
export type UnpaidInvoice = { id: number; number: string; date: string | null; dueDate: string | null; total: number; due: number; communication: string; label: string; subscription: { name: string; period: CoworkPeriod } | null };

export async function unpaidInvoices(odoo: OdooCall, partnerIds: number[], sub: CoworkSubscription | null): Promise<UnpaidInvoice[]> {
  if (!partnerIds.length) return [];
  const moves = (await odoo("account.move", "search_read", {
    domain: [["partner_id", "child_of", partnerIds], ["move_type", "=", "out_invoice"], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]],
    fields: ["id", "name", "invoice_date", "invoice_date_due", "amount_total", "amount_residual", "payment_reference", "invoice_origin"],
    order: "invoice_date asc, id asc",
    limit: 20,
  })) as { id: number; name: string; invoice_date: string | false; invoice_date_due: string | false; amount_total: number; amount_residual: number; payment_reference: string | false; invoice_origin: string | false }[];
  if (!moves.length) return [];
  const lines = (await odoo("account.move.line", "search_read", { domain: [["move_id", "in", moves.map((m) => m.id)], ["display_type", "=", "product"]], fields: ["move_id", "name"], order: "id asc" })) as { move_id: [number, string] | false; name: string | false }[];
  const label = new Map<number, string>();
  for (const l of lines) if (l.move_id && !label.has(l.move_id[0]) && typeof l.name === "string" && l.name.trim()) label.set(l.move_id[0], l.name.split("\n")[0].trim().slice(0, 140));
  return moves.map((m) => ({
    id: m.id,
    number: m.name,
    date: m.invoice_date || null,
    dueDate: m.invoice_date_due || null,
    total: m.amount_total,
    due: m.amount_residual,
    communication: (typeof m.payment_reference === "string" && m.payment_reference) || m.name,
    label: label.get(m.id) || "Invoice",
    subscription: sub && m.invoice_origin === sub.name ? { name: sub.name, period: sub.period } : null,
  }));
}
