import { assertEquals } from "jsr:@std/assert";
import { odooHistory, stripeHistory } from "../src/lib/euro-history.ts";

Deno.test("odooHistory: invoices paid are negative, refunds positive, labelled by their first line", async () => {
  const odoo = (model: string) => {
    if (model === "account.move") {
      return Promise.resolve([
        { id: 2, name: "INV/2026/0002", invoice_date: "2026-11-10", amount_total_signed: 121, move_type: "out_invoice", invoice_origin: false },
        { id: 3, name: "RINV/2026/0001", invoice_date: "2026-11-12", amount_total_signed: -24.2, move_type: "out_refund", invoice_origin: false },
      ]);
    }
    return Promise.resolve([{ move_id: [2, "INV"], name: "Coworking\nmonthly" }]);
  };
  // deno-lint-ignore no-explicit-any
  const txs = await odooHistory(odoo as any, [1]);
  assertEquals(txs, [
    { at: "2026-11-10T12:00:00Z", amount: -121, description: "Coworking (INV/2026/0002)" },
    { at: "2026-11-12T12:00:00Z", amount: 24.2, description: "Refund (RINV/2026/0001)" },
  ]);
});

Deno.test("stripeHistory: paid subscription invoices of the customers with that email", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_x");
  const fetcher = (url: string | URL | Request) => {
    const u = String(url);
    const body = u.includes("/customers") ? { data: [{ id: "cus_1" }] } : { data: [{ id: "in_1", number: "A-1", amount_paid: 1500, status: "paid", created: 1763200000, status_transitions: { paid_at: 1763200000 }, lines: { data: [{ description: "1 × Membership (at €15.00 / month)" }] } }, { id: "in_0", number: null, amount_paid: 0, status: "paid", created: 1 }] };
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  const txs = await stripeHistory("A@x.org", fetcher as typeof fetch);
  assertEquals(txs, [{ at: new Date(1763200000000).toISOString(), amount: -15, description: "1 × Membership (at €15.00 / month)" }]);
});
