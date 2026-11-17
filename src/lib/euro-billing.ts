/**
 * Paying in euros from the website: every booking gets an Odoo invoice, addressed to one of the
 * member's organisations (or to themselves), paid now by card (Stripe Checkout, on the website) or
 * later by bank transfer with the invoice's structured communication.
 *
 * Prices are the website's, before VAT; an active member gets MEMBER_DISCOUNT % off, shown as a
 * discount on the invoice line; then 21% VAT.
 *
 * Which organisations a member may invoice is kept here, per guild, in invoice-orgs.json
 * (Discord user id → Odoo partner ids): a member only ever sees and edits the ones they added. The
 * invoices made this way are logged in website-invoices.jsonl.
 *
 * Odoo (commonshub.odoo.com): invoices go to the RCC journal (rental, coworking, catering;
 * ODOO_SALES_JOURNAL_ID, default 11), each line on account 700003 (ODOO_INCOME_ACCOUNT_CODE) with
 * the 21% services tax (ODOO_SALE_TAX_ID, default 163): the products carry no account or tax. A
 * card payment is not registered here: chb's hourly Stripe sync books each charge and reconciles
 * it with the invoice by its number, which the website puts on the Stripe Checkout.
 */
import { getEnv } from "./utils.ts";
import type { OdooCall } from "./odoo.ts";

export const MEMBER_DISCOUNT = 30;
export const VAT_RATE = 21;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type InvoiceLine = { label: string; quantity: number; unitPrice: number; discount: number };
export type Quote = { lines: InvoiceLine[]; untaxed: number; vat: number; total: number; discount: number };

/** What a booking costs in euros: before VAT, the member discount, VAT, total. */
export function quote(lines: InvoiceLine[]): Quote {
  const untaxed = round2(lines.reduce((s, l) => s + round2(l.quantity * l.unitPrice * (1 - l.discount / 100)), 0));
  const vat = round2(untaxed * VAT_RATE / 100);
  return { lines, untaxed, vat, total: round2(untaxed + vat), discount: lines[0]?.discount ?? 0 };
}

export const roomLine = (roomName: string, eurPerHour: number, hours: number, member: boolean, when: string): InvoiceLine => ({
  label: `${roomName}, ${when}`,
  quantity: Number(hours.toFixed(2)),
  unitPrice: eurPerHour,
  discount: member ? MEMBER_DISCOUNT : 0,
});

export const coworkLine = (label: string, eur: number, member: boolean, when: string): InvoiceLine => ({
  label: `${label}, ${when}`,
  quantity: 1,
  unitPrice: eur,
  discount: member ? MEMBER_DISCOUNT : 0,
});

// ── Organisations ───────────────────────────────────────────────────────────

export type Address = { street: string; zip: string; city: string; country: string };
export type Org = {
  id: number;
  name: string;
  vat: string | null;
  email: string | null;
  address: Address;
  /** A separate address for invoices (an Odoo "invoice" contact under the company). */
  billing: (Address & { id: number }) | null;
  /** The member themselves, no company. */
  self?: boolean;
};
export type OrgInput = {
  id?: number;
  name: string;
  vat?: string;
  email: string;
  address: Address;
  billing?: Address | null;
};

const orgsFile = (guildId: string) => `${getEnv("DATA_DIR") || "/data"}/${guildId}/invoice-orgs.json`;
const invoicesFile = (guildId: string) => `${getEnv("DATA_DIR") || "/data"}/${guildId}/website-invoices.jsonl`;

async function readOrgIds(guildId: string): Promise<Record<string, number[]>> {
  try {
    return JSON.parse(await Deno.readTextFile(orgsFile(guildId)));
  } catch {
    return {};
  }
}

async function addOrgId(guildId: string, userId: string, id: number) {
  const all = await readOrgIds(guildId);
  all[userId] = [...new Set([...(all[userId] ?? []), id])];
  const path = orgsFile(guildId);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(all, null, 2));
}

export async function userOrgIds(guildId: string, userId: string): Promise<number[]> {
  return (await readOrgIds(guildId))[userId] ?? [];
}

type Partner = {
  id: number;
  name: string;
  vat: string | false;
  email: string | false;
  street: string | false;
  zip: string | false;
  city: string | false;
  country_id: [number, string] | false;
  country_code?: string | false;
  type?: string;
  parent_id?: [number, string] | false;
};
const PARTNER_FIELDS = ["id", "name", "vat", "email", "street", "zip", "city", "country_id", "country_code", "type", "parent_id"];
const s = (v: string | false | undefined | null) => (typeof v === "string" ? v : "");
const addressOf = (p: Partner): Address => ({ street: s(p.street), zip: s(p.zip), city: s(p.city), country: s(p.country_code) || "BE" });

/** The member's own partner in Odoo, found by their email (null when we have no email or no match). */
export async function selfPartner(odoo: OdooCall, email: string | undefined): Promise<Partner | null> {
  if (!email) return null;
  const found = (await odoo("res.partner", "search_read", {
    domain: [["email", "=ilike", email], ["is_company", "=", false]],
    fields: PARTNER_FIELDS,
    limit: 1,
  })) as Partner[];
  return found[0] ?? null;
}

async function billingChild(odoo: OdooCall, parentId: number): Promise<Partner | null> {
  const found = (await odoo("res.partner", "search_read", {
    domain: [["parent_id", "=", parentId], ["type", "=", "invoice"], ["active", "=", true]],
    fields: PARTNER_FIELDS,
    limit: 1,
  })) as Partner[];
  return found[0] ?? null;
}

async function toOrg(odoo: OdooCall, p: Partner, self = false): Promise<Org> {
  const b = await billingChild(odoo, p.id);
  return {
    id: p.id,
    name: p.name,
    vat: s(p.vat) || null,
    email: s(p.email) || null,
    address: addressOf(p),
    billing: b ? { id: b.id, ...addressOf(b) } : null,
    ...(self ? { self: true } : {}),
  };
}

/** The organisations this member can invoice, and themselves (when Odoo knows them). */
export async function listOrgs(odoo: OdooCall, guildId: string, userId: string, email: string | undefined): Promise<Org[]> {
  const ids = await userOrgIds(guildId, userId);
  const partners = ids.length
    ? ((await odoo("res.partner", "read", { ids, fields: PARTNER_FIELDS })) as Partner[])
    : [];
  const orgs = await Promise.all(partners.map((p) => toOrg(odoo, p)));
  const me = await selfPartner(odoo, email);
  if (me && !ids.includes(me.id)) orgs.push(await toOrg(odoo, me, true));
  return orgs;
}

async function countryId(odoo: OdooCall, code: string): Promise<number | false> {
  const found = (await odoo("res.country", "search_read", { domain: [["code", "=", code.toUpperCase()]], fields: ["id"], limit: 1 })) as { id: number }[];
  return found[0]?.id ?? false;
}

const cleanVat = (vat: string | undefined) => (vat ?? "").replace(/[\s.\-]/g, "").toUpperCase();

/** Why this organisation can't be saved, or null. */
export function checkOrgInput(o: OrgInput): string | null {
  if (!o.name.trim()) return "The organisation needs a name.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) return "The email address for invoices doesn't look valid.";
  if (!o.address.street.trim() || !o.address.zip.trim() || !o.address.city.trim()) return "Give the full address: street, postcode and city.";
  if (o.vat && !/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(cleanVat(o.vat))) return "That VAT number doesn't look valid (e.g. BE0123456789).";
  if (o.billing && (!o.billing.street.trim() || !o.billing.zip.trim() || !o.billing.city.trim())) return "Give the full billing address, or untick it.";
  return null;
}

/**
 * Create or update one of the member's organisations, and its billing address. A member can only
 * update an organisation they added, or their own partner.
 */
export async function saveOrg(odoo: OdooCall, guildId: string, userId: string, email: string | undefined, input: OrgInput): Promise<{ ok: true; org: Org } | { ok: false; error: string; status: number }> {
  const invalid = checkOrgInput(input);
  if (invalid) return { ok: false, error: invalid, status: 400 };
  const mine = await userOrgIds(guildId, userId);
  const me = await selfPartner(odoo, email);
  if (input.id && !mine.includes(input.id) && input.id !== me?.id) return { ok: false, error: "You can only edit your own organisations.", status: 403 };

  const vals: Record<string, unknown> = {
    name: input.name.trim(),
    email: input.email.trim(),
    street: input.address.street.trim(),
    zip: input.address.zip.trim(),
    city: input.address.city.trim(),
    country_id: await countryId(odoo, input.address.country || "BE"),
    vat: cleanVat(input.vat) || false,
  };
  let id = input.id;
  if (id) {
    await odoo("res.partner", "write", { ids: [id], vals });
  } else {
    id = ((await odoo("res.partner", "create", { vals_list: [{ ...vals, is_company: true }] })) as number[])[0];
    await addOrgId(guildId, userId, id);
  }

  const existing = await billingChild(odoo, id);
  if (input.billing) {
    const b = {
      street: input.billing.street.trim(),
      zip: input.billing.zip.trim(),
      city: input.billing.city.trim(),
      country_id: await countryId(odoo, input.billing.country || input.address.country || "BE"),
    };
    if (existing) await odoo("res.partner", "write", { ids: [existing.id], vals: b });
    else await odoo("res.partner", "create", { vals_list: [{ ...b, parent_id: id, type: "invoice", name: "Billing address", email: input.email.trim() }] });
  } else if (existing) {
    await odoo("res.partner", "write", { ids: [existing.id], vals: { active: false } });
  }

  const [p] = (await odoo("res.partner", "read", { ids: [id], fields: PARTNER_FIELDS })) as Partner[];
  return { ok: true, org: await toOrg(odoo, p, id === me?.id) };
}

// ── VAT numbers (VIES) ──────────────────────────────────────────────────────

export type VatLookup = { valid: boolean; name?: string; address?: Partial<Address> };

/** VIES's "STREET 1\n1000 CITY" into our fields. */
export function parseViesAddress(text: string | undefined, country: string): Partial<Address> {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return {};
  const last = lines[lines.length - 1];
  const m = last.match(/^(\d{4,5})\s+(.+)$/);
  return m
    ? { street: lines.slice(0, -1).join(", "), zip: m[1], city: m[2], country }
    : { street: lines.join(", "), country };
}

/** Check a VAT number on VIES and read the registered name and address. */
export async function lookupVat(vat: string, fetcher: typeof fetch = fetch): Promise<VatLookup> {
  const v = cleanVat(vat);
  const m = v.match(/^([A-Z]{2})([A-Z0-9]+)$/);
  if (!m) return { valid: false };
  const country = m[1] === "EL" ? "GR" : m[1];
  const res = await fetcher(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${m[1]}/vat/${m[2]}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`VIES answered ${res.status}`);
  const r = await res.json() as { isValid?: boolean; name?: string; address?: string };
  if (!r.isValid) return { valid: false };
  const name = r.name && r.name !== "---" ? r.name : undefined;
  return { valid: true, ...(name ? { name } : {}), address: parseViesAddress(r.address && r.address !== "---" ? r.address : undefined, country) };
}

// ── Invoices ────────────────────────────────────────────────────────────────

export type Invoice = {
  id: number;
  number: string;
  untaxed: number;
  vat: number;
  total: number;
  communication: string;
  due: string | null;
  partnerName: string;
  sentTo: string | null;
  emailed: boolean;
};

const saleTax = () => Number(getEnv("ODOO_SALE_TAX_ID")) || 163;
const salesJournal = () => Number(getEnv("ODOO_SALES_JOURNAL_ID")) || 11;

let incomeAccount: { code: string; id: number } | null = null;
async function incomeAccountId(odoo: OdooCall): Promise<number> {
  const code = getEnv("ODOO_INCOME_ACCOUNT_CODE") || "700003";
  if (incomeAccount?.code === code) return incomeAccount.id;
  const found = (await odoo("account.account", "search_read", { domain: [["code", "=", code]], fields: ["id"], limit: 1 })) as { id: number }[];
  if (!found[0]) throw new Error(`No account ${code} in Odoo`);
  incomeAccount = { code, id: found[0].id };
  return found[0].id;
}

/** Send a posted invoice by email with the default template (best effort: false when it fails). */
async function emailInvoice(odoo: OdooCall, moveId: number): Promise<boolean> {
  try {
    const context = { active_model: "account.move", active_ids: [moveId], active_id: moveId };
    const [wizard] = (await odoo("account.move.send.wizard", "create", { vals_list: [{ move_id: moveId }], context })) as number[];
    await odoo("account.move.send.wizard", "action_send_and_print", { ids: [wizard], context });
    return true;
  } catch (error) {
    console.error("[euro-billing] could not email the invoice:", (error as Error)?.message || error);
    return false;
  }
}

/**
 * Create, post and email an invoice. `to` is one of the member's organisations, or "self" (their
 * own partner, created from their Discord name and email when Odoo doesn't know them yet).
 */
export async function createInvoice(odoo: OdooCall, p: {
  guildId: string;
  userId: string;
  member: { name: string; email?: string };
  to: number | "self";
  lines: InvoiceLine[];
  ref: string;
}): Promise<{ ok: true; invoice: Invoice } | { ok: false; error: string; status: number }> {
  let partnerId: number;
  if (p.to === "self") {
    const me = await selfPartner(odoo, p.member.email);
    if (me) partnerId = me.id;
    else if (p.member.email) partnerId = ((await odoo("res.partner", "create", { vals_list: [{ name: p.member.name, email: p.member.email }] })) as number[])[0];
    else return { ok: false, error: "We don't have your email address: add an organisation to invoice instead.", status: 400 };
  } else {
    const mine = await userOrgIds(p.guildId, p.userId);
    const me = await selfPartner(odoo, p.member.email);
    if (!mine.includes(p.to) && p.to !== me?.id) return { ok: false, error: "Choose one of your organisations.", status: 403 };
    partnerId = p.to;
  }
  const billing = await billingChild(odoo, partnerId);
  const tax = saleTax();
  const account = await incomeAccountId(odoo);
  const [moveId] = (await odoo("account.move", "create", {
    vals_list: [{
      move_type: "out_invoice",
      journal_id: salesJournal(),
      partner_id: billing?.id ?? partnerId,
      ref: p.ref,
      invoice_line_ids: p.lines.map((l) => [0, 0, { name: l.label, quantity: l.quantity, price_unit: l.unitPrice, discount: l.discount, account_id: account, tax_ids: [[6, 0, [tax]]] }]),
    }],
  })) as number[];
  await odoo("account.move", "action_post", { ids: [moveId] });
  const [m] = (await odoo("account.move", "read", {
    ids: [moveId],
    fields: ["name", "amount_untaxed", "amount_tax", "amount_total", "payment_reference", "invoice_date_due", "partner_id"],
  })) as { name: string; amount_untaxed: number; amount_tax: number; amount_total: number; payment_reference: string | false; invoice_date_due: string | false; partner_id: [number, string] }[];
  const [partner] = (await odoo("res.partner", "read", { ids: [partnerId], fields: ["email"] })) as { email: string | false }[];
  const emailed = await emailInvoice(odoo, moveId);
  const path = invoicesFile(p.guildId);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify({ invoiceId: moveId, number: m.name, userId: p.userId, total: m.amount_total, at: new Date().toISOString() }) + "\n", { append: true });
  return {
    ok: true,
    invoice: {
      id: moveId,
      number: m.name,
      untaxed: m.amount_untaxed,
      vat: m.amount_tax,
      total: m.amount_total,
      communication: s(m.payment_reference) || m.name,
      due: s(m.invoice_date_due) || null,
      partnerName: m.partner_id?.[1] ?? "",
      sentTo: s(partner?.email) || null,
      emailed,
    },
  };
}
