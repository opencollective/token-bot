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
  const period: CoworkPeriod = p.period === "year" ? "year" : "month";
  const price = period === "year" ? COWORK_YEARLY_EUR : COWORK_MONTHLY_EUR;
  const [orderId] = (await odoo("sale.order", "create", {
    vals_list: [{
      partner_id: self.partnerId,
      partner_invoice_id: billing?.id ?? payer.partnerId,
      plan_id: planId(period),
      start_date: today,
      // Invoiced on the rental-coworking-catering journal, like the bookings (Odoo would pick "Memberships").
      journal_id: salesJournal(),
      origin: "Website",
      order_line: [[0, 0, { product_id: productId(), name: period === "year" ? "Unlimited coworking (yearly, two months free)" : "Unlimited coworking (monthly)", product_uom_qty: 1, price_unit: price, tax_ids: [[6, 0, [saleTax()]]] }]],
    }],
  })) as number[];
  await odoo("sale.order", "action_confirm", { ids: [orderId] });
  // The first month (or the year), invoiced now (later months: Odoo's subscription invoicing).
  let invoice: Invoice | null = null;
  try {
    const [wizard] = (await odoo("sale.advance.payment.inv", "create", { vals_list: [{ advance_payment_method: "delivered", sale_order_ids: [[6, 0, [orderId]]] }] })) as number[];
    await odoo("sale.advance.payment.inv", "create_invoices", { ids: [wizard] });
    const [order] = (await odoo("sale.order", "read", { ids: [orderId], fields: ["invoice_ids"] })) as { invoice_ids: number[] }[];
    const moveId = Math.max(...(order?.invoice_ids ?? []));
    if (Number.isFinite(moveId) && moveId > 0) {
      const [m] = (await odoo("account.move", "read", { ids: [moveId], fields: ["state"] })) as { state: string }[];
      if (m?.state === "draft") await odoo("account.move", "action_post", { ids: [moveId] });
      invoice = await finishInvoice(odoo, moveId, { guildId: p.guildId, userId: p.userId, partnerId: payer.partnerId });
    }
  } catch (error) {
    console.error("[cowork-subscription] the first invoice could not be made:", error);
  }
  const subscription = (await coworkSubscriptionOf(odoo, self.partnerId)) ?? { id: orderId, name: `S${orderId}`, since: today, nextInvoice: null, monthly: period === "year" ? price / 12 : price, period, amount: price };
  return { ok: true, subscription, invoice };
}
