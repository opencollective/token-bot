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
import { likeLiteral, type OdooCall } from "./odoo.ts";

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
  /** The language Odoo writes to them in (invoice emails): en_GB, fr_BE or nl_BE. */
  lang: Lang;
  /** Saved as new but already in Odoo (same VAT number): linked, its details kept as they were. */
  existing?: boolean;
  /** The company the member is a contact of in Odoo (their partner's parent): theirs to invoice, not to edit here. */
  contact?: boolean;
};

export const LANGS = ["en_GB", "fr_BE", "nl_BE"] as const;
export type Lang = typeof LANGS[number];
/** English unless the member picks French or Dutch (Odoo's own default here is Dutch). */
export const DEFAULT_LANG: Lang = "en_GB";
const asLang = (v: unknown): Lang | null => (LANGS as readonly string[]).includes(String(v)) ? v as Lang : null;
export type OrgInput = {
  id?: number;
  name: string;
  vat?: string;
  email: string;
  address: Address;
  billing?: Address | null;
  lang?: string;
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
  lang?: string | false;
};
const PARTNER_FIELDS = ["id", "name", "vat", "email", "street", "zip", "city", "country_id", "country_code", "type", "parent_id", "lang"];
const s = (v: string | false | undefined | null) => (typeof v === "string" ? v : "");
const addressOf = (p: Partner): Address => ({ street: s(p.street), zip: s(p.zip), city: s(p.city), country: s(p.country_code) || "BE" });

/** The member's own partner in Odoo, found by their email (null when we have no email or no match). */
export async function selfPartner(odoo: OdooCall, email: string | undefined): Promise<Partner | null> {
  if (!email) return null;
  const found = (await odoo("res.partner", "search_read", {
    domain: [["email", "=ilike", likeLiteral(email.trim())], ["is_company", "=", false]],
    fields: PARTNER_FIELDS,
    limit: 5,
  })) as Partner[];
  return found.find((p) => s(p.email).trim().toLowerCase() === email.trim().toLowerCase()) ?? null;
}

export async function billingChild(odoo: OdooCall, parentId: number): Promise<Partner | null> {
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
    lang: asLang(p.lang) ?? DEFAULT_LANG,
    ...(self ? { self: true } : {}),
  };
}

/** The company the member's own partner is a contact of in Odoo, if any. */
export const companyIdOf = (me: Pick<Partner, "id" | "parent_id"> | null): number | null => (me && Array.isArray(me.parent_id) && me.parent_id[0] !== me.id ? me.parent_id[0] : null);

/**
 * The organisations this member can invoice: the ones they added, the company Odoo has them as a
 * contact of, and themselves (when Odoo knows them).
 */
export async function listOrgs(odoo: OdooCall, guildId: string, userId: string, email: string | undefined): Promise<Org[]> {
  const ids = await userOrgIds(guildId, userId);
  const me = await selfPartner(odoo, email);
  const company = companyIdOf(me);
  const all = [...ids, ...(company && !ids.includes(company) ? [company] : [])];
  const partners = all.length
    ? ((await odoo("res.partner", "read", { ids: all, fields: PARTNER_FIELDS })) as Partner[])
    : [];
  const orgs = await Promise.all(partners.map(async (p) => ({ ...(await toOrg(odoo, p)), ...(p.id === company && !ids.includes(p.id) ? { contact: true } : {}) })));
  if (me && !all.includes(me.id)) orgs.push(await toOrg(odoo, me, true));
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
    ...(asLang(input.lang) ? { lang: asLang(input.lang) } : input.id ? {} : { lang: DEFAULT_LANG }),
  };
  let id = input.id;
  if (id) {
    await odoo("res.partner", "write", { ids: [id], vals });
  } else {
    // A company already in our books (same VAT number): link it rather than make a duplicate, and keep its details.
    const vatNumber = cleanVat(input.vat);
    const same = vatNumber
      ? ((await odoo("res.partner", "search_read", { domain: [["vat", "=ilike", likeLiteral(vatNumber)], ["is_company", "=", true], ["active", "=", true]], fields: PARTNER_FIELDS, order: "id asc", limit: 1 })) as Partner[])[0]
      : undefined;
    if (same) {
      await addOrgId(guildId, userId, same.id);
      return { ok: true, org: { ...(await toOrg(odoo, same)), existing: true } };
    }
    id = ((await odoo("res.partner", "create", { vals_list: [{ ...vals, is_company: true }] })) as number[])[0];
    await addOrgId(guildId, userId, id);
  }
  const lang = asLang(input.lang);

  const existing = await billingChild(odoo, id);
  if (input.billing) {
    const b = {
      street: input.billing.street.trim(),
      zip: input.billing.zip.trim(),
      city: input.billing.city.trim(),
      country_id: await countryId(odoo, input.billing.country || input.address.country || "BE"),
    };
    // Invoices go to this contact: its email and language are the organisation's.
    const contact = { ...b, email: input.email.trim(), ...(lang ? { lang } : {}) };
    if (existing) await odoo("res.partner", "write", { ids: [existing.id], vals: contact });
    else await odoo("res.partner", "create", { vals_list: [{ ...contact, parent_id: id, type: "invoice", name: "Billing address", lang: lang ?? DEFAULT_LANG }] });
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

export const saleTax = () => Number(getEnv("ODOO_SALE_TAX_ID")) || 163;
export const salesJournal = () => Number(getEnv("ODOO_SALES_JOURNAL_ID")) || 11;

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
/** A room (start, end) or coworking on a day (Brussels date), as booked. */
export type Booked = { kind: "room"; label: string; start: string; end: string; guest?: string } | { kind: "cowork"; label: string; date: string };

type InvoiceRecord = { invoiceId: number; number: string; userId: string; total: number; communication?: string; booking?: Booked; at: string };
type CardPaid = { invoiceId: number; userId: string; sessionId: string; at: string };
/** Invoices paid by card on the website, not reconciled in Odoo yet. */
export async function cardPaidInvoiceIds(guildId: string): Promise<Set<number>> {
  return new Set((await readJsonl<CardPaid>(paidFile(guildId))).map((c) => c.invoiceId));
}
const paidFile = (guildId: string) => `${getEnv("DATA_DIR") || "/data"}/${guildId}/website-card-payments.jsonl`;

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    return (await Deno.readTextFile(path)).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

// ── Cancellation (Commons Hub terms, section 3: shop.commonshub.brussels/terms, linked on every invoice) ──
//
// Full refund up to 30 days before, 50% between 30 and 7 days, none within 7 days. A refund is a
// credit note on the invoice (reconciled with it when it is still unpaid); when the invoice was
// already paid, stewards are told to pay the refund back (the bot never moves money).

export const CANCELLATION_POLICY = "Full refund up to 30 days before, 50% between 30 and 7 days before, no refund within 7 days (Commons Hub terms, section 3).";

/** The share refunded when cancelling now, by the Commons Hub terms. */
export function refundPercent(start: Date, now = new Date()): 0 | 50 | 100 {
  const days = (start.getTime() - now.getTime()) / 86_400_000;
  return days >= 30 ? 100 : days >= 7 ? 50 : 0;
}

type BookingEvent = { invoiceId: number; calendarId: string; eventId: string };
type Cancellation = { invoiceId: number; userId: string; refundPercent: number; creditNote?: { id: number; number: string; total: number }; refundDue?: number; at: string };
const eventsFile = (guildId: string) => `${getEnv("DATA_DIR") || "/data"}/${guildId}/website-booking-events.jsonl`;
const cancelsFile = (guildId: string) => `${getEnv("DATA_DIR") || "/data"}/${guildId}/website-cancellations.jsonl`;

async function appendJsonl(path: string, row: unknown) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(row) + "\n", { append: true });
}

/** The calendar event of a room booked in euros (made after its invoice), for cancelling it later. */
export async function recordBookingEvent(guildId: string, invoiceId: number, calendarId: string, eventId: string) {
  await appendJsonl(eventsFile(guildId), { invoiceId, calendarId, eventId });
}

export type MyBooking = Booked & {
  /** due: what is left to pay on it (after payments and credit notes). */
  invoice: { id: number; number: string; total: number; communication: string; pdfUrl: string | null; due: number };
  status: "paid" | "partial" | "pending" | "cancelled";
  /** A room not started yet: what cancelling now refunds. */
  cancel?: { refundPercent: number; refund: number };
  /** Cancelled: the credit note, if any. */
  creditNote?: { number: string; total: number; pdfUrl: string | null };
};

type MoveRead = { id: number; name: string; payment_state: string; access_token: string | false; amount_total: number; amount_residual: number };

/** The invoice PDF as the customer portal serves it (the link Odoo emails them). */
const pdfUrl = (base: string, m: Pick<MoveRead, "id" | "access_token"> | undefined) =>
  base && m && m.access_token ? `${base.replace(/\/$/, "")}/my/invoices/${m.id}?access_token=${m.access_token}&report_type=pdf&download=true` : null;

/**
 * A member's bookings paid in euros, with their invoice (and its PDF) and whether it is paid: in
 * Odoo (paid, or in payment), or by card on the website (the Stripe payment reaches Odoo with
 * chb's hourly sync, so the card record covers the gap). Upcoming: rooms not over yet and
 * coworking from today, soonest first. Past: over within the last year, latest first.
 */
export async function myBookings(odoo: OdooCall, guildId: string, userId: string, { now = new Date(), past = false, odooUrl = "" } = {}): Promise<MyBooking[]> {
  const today = now.toLocaleDateString("en-CA", { timeZone: "Europe/Brussels" });
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000);
  const upcoming = (b: Booked) => (b.kind === "room" ? new Date(b.end) > now : b.date >= today);
  const recent = (b: Booked) => (b.kind === "room" ? new Date(b.end) > yearAgo : b.date >= yearAgo.toISOString().slice(0, 10));
  const cancels = new Map((await readJsonl<Cancellation>(cancelsFile(guildId))).filter((c) => c.userId === userId).map((c) => [c.invoiceId, c]));
  const mine = (await readJsonl<InvoiceRecord>(invoicesFile(guildId))).filter((r) =>
    r.userId === userId && r.booking && (past ? (!upcoming(r.booking) || cancels.has(r.invoiceId)) && recent(r.booking) : upcoming(r.booking) && !cancels.has(r.invoiceId))
  );
  if (!mine.length) return [];
  const card = new Set((await readJsonl<CardPaid>(paidFile(guildId))).filter((c) => c.userId === userId).map((c) => c.invoiceId));
  const ids = [...mine.map((r) => r.invoiceId), ...mine.flatMap((r) => (cancels.get(r.invoiceId)?.creditNote ? [cancels.get(r.invoiceId)!.creditNote!.id] : []))];
  const moves = new Map(((await odoo("account.move", "read", { ids, fields: ["name", "payment_state", "access_token", "amount_total", "amount_residual"] })) as MoveRead[]).map((m) => [m.id, m]));
  const startOf = (b: Booked) => (b.kind === "room" ? b.start : b.date);
  return mine
    .filter((r) => moves.has(r.invoiceId))
    .map((r): MyBooking => {
      const m = moves.get(r.invoiceId)!;
      const c = cancels.get(r.invoiceId);
      const st = m.payment_state;
      const status = c ? "cancelled" as const : card.has(r.invoiceId) || st === "paid" || st === "in_payment" || st === "reversed" ? "paid" as const : st === "partial" ? "partial" as const : "pending" as const;
      const b = r.booking!;
      const refund = b.kind === "room" && !c && new Date(b.start) > now ? refundPercent(new Date(b.start), now) : null;
      return {
        ...b,
        invoice: { id: r.invoiceId, number: r.number, total: r.total, communication: r.communication ?? r.number, pdfUrl: pdfUrl(odooUrl, m), due: status === "paid" ? 0 : Math.max(0, m.amount_residual ?? 0) },
        status,
        ...(refund !== null ? { cancel: { refundPercent: refund, refund: Math.round(r.total * refund) / 100 } } : {}),
        ...(c?.creditNote ? { creditNote: { number: c.creditNote.number, total: c.creditNote.total, pdfUrl: pdfUrl(odooUrl, moves.get(c.creditNote.id)) } } : {}),
      };
    })
    .sort((a, b) => (past ? startOf(b).localeCompare(startOf(a)) : startOf(a).localeCompare(startOf(b))));
}

/**
 * Cancel a member's room booked in euros, before it starts: free the calendar (not for a test
 * user's, which was never booked), and refund by the terms with a credit note. Returns what the
 * member is told; `notify` is called when a paid invoice needs a refund paid back.
 */
export async function cancelBooking(
  odoo: OdooCall,
  p: { guildId: string; userId: string; invoiceId: number; now?: Date; deleteEvent?: (calendarId: string, eventId: string) => Promise<void>; notify?: (text: string) => Promise<void> },
): Promise<{ ok: true; refundPercent: number; creditNote: { number: string; total: number } | null; refundDue: number } | { ok: false; error: string; status: number }> {
  const now = p.now ?? new Date();
  const r = (await readJsonl<InvoiceRecord>(invoicesFile(p.guildId))).find((x) => x.userId === p.userId && x.invoiceId === p.invoiceId);
  if (!r || r.booking?.kind !== "room") return { ok: false, error: "That booking isn't yours, or it can't be cancelled here.", status: 404 };
  if ((await readJsonl<Cancellation>(cancelsFile(p.guildId))).some((c) => c.invoiceId === p.invoiceId)) return { ok: false, error: "This booking is already cancelled.", status: 409 };
  const start = new Date(r.booking.start);
  if (start <= now) return { ok: false, error: "This booking has already started.", status: 409 };
  const percent = refundPercent(start, now);

  const ev = (await readJsonl<BookingEvent>(eventsFile(p.guildId))).find((e) => e.invoiceId === p.invoiceId);
  if (ev && p.deleteEvent) await p.deleteEvent(ev.calendarId, ev.eventId);

  const [inv] = (await odoo("account.move", "read", { ids: [p.invoiceId], fields: ["name", "partner_id", "journal_id", "payment_state", "amount_total"] })) as { name: string; partner_id: [number, string]; journal_id: [number, string]; payment_state: string; amount_total: number }[];
  let creditNote: { id: number; number: string; total: number } | null = null;
  if (percent > 0) {
    const lines = (await odoo("account.move.line", "search_read", {
      domain: [["move_id", "=", p.invoiceId], ["display_type", "=", "product"]],
      fields: ["name", "quantity", "price_unit", "discount", "account_id", "tax_ids"],
    })) as { name: string; quantity: number; price_unit: number; discount: number; account_id: [number, string]; tax_ids: number[] }[];
    const [refundId] = (await odoo("account.move", "create", {
      vals_list: [{
        move_type: "out_refund",
        journal_id: inv.journal_id[0],
        partner_id: inv.partner_id[0],
        reversed_entry_id: p.invoiceId,
        ref: `Cancellation of ${inv.name}${percent < 100 ? ` (${percent}% refund, Commons Hub terms)` : ""}`,
        invoice_line_ids: lines.map((l) => [0, 0, { name: `${l.name} (cancelled${percent < 100 ? `, ${percent}% refunded` : ""})`, quantity: l.quantity, price_unit: Math.round(l.price_unit * percent) / 100, discount: l.discount, account_id: l.account_id[0], tax_ids: [[6, 0, l.tax_ids]] }]),
      }],
    })) as number[];
    await odoo("account.move", "action_post", { ids: [refundId] });
    const [cn] = (await odoo("account.move", "read", { ids: [refundId], fields: ["name", "amount_total"] })) as { name: string; amount_total: number }[];
    creditNote = { id: refundId, number: cn.name, total: cn.amount_total };
    // Still unpaid: the credit note settles (part of) the invoice.
    if (!["paid", "in_payment"].includes(inv.payment_state)) {
      const [line] = (await odoo("account.move.line", "search_read", { domain: [["move_id", "=", refundId], ["account_id.account_type", "=", "asset_receivable"], ["reconciled", "=", false]], fields: ["id"], limit: 1 })) as { id: number }[];
      if (line) await odoo("account.move", "js_assign_outstanding_line", { ids: [p.invoiceId], line_id: line.id }).catch((e) => console.error("[euro-billing] could not reconcile the credit note:", e));
    }
    await emailInvoice(odoo, refundId);
  }
  const card = (await readJsonl<CardPaid>(paidFile(p.guildId))).some((c) => c.invoiceId === p.invoiceId);
  const wasPaid = card || ["paid", "in_payment"].includes(inv.payment_state);
  const refundDue = wasPaid && creditNote ? creditNote.total : 0;
  await appendJsonl(cancelsFile(p.guildId), { invoiceId: p.invoiceId, userId: p.userId, refundPercent: percent, ...(creditNote ? { creditNote } : {}), ...(refundDue ? { refundDue } : {}), at: now.toISOString() });
  if (refundDue && p.notify) {
    await p.notify(`Booking cancelled on the website: ${r.booking.label}, ${r.booking.start}. Invoice ${inv.name} was paid${card ? " by card (Stripe)" : ""}; credit note ${creditNote!.number}: please refund €${refundDue.toFixed(2)} to the member.`).catch((e) => console.error("[euro-billing] could not notify stewards:", e));
  }
  return { ok: true, refundPercent: percent, creditNote: creditNote ? { number: creditNote.number, total: creditNote.total } : null, refundDue };
}

/** The website saw this invoice paid by card (Stripe Checkout): note it, if it is this member's. */
export async function recordCardPayment(guildId: string, userId: string, invoiceId: number, sessionId: string, theirs?: () => Promise<boolean>): Promise<boolean> {
  // One the website made for them, or (theirs) one of their own invoices in Odoo (unpaid invoices on the dashboard).
  const own = (await readJsonl<InvoiceRecord>(invoicesFile(guildId))).some((r) => r.userId === userId && r.invoiceId === invoiceId) || (!!theirs && (await theirs().catch(() => false)));
  if (!own) return false;
  const path = paidFile(guildId);
  if ((await readJsonl<CardPaid>(path)).some((c) => c.invoiceId === invoiceId)) return true;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify({ invoiceId, userId, sessionId, at: new Date().toISOString() }) + "\n", { append: true });
  return true;
}

export async function createInvoice(odoo: OdooCall, p: {
  guildId: string;
  userId: string;
  member: { name: string; email?: string };
  to: number | "self";
  lines: InvoiceLine[];
  ref: string;
  /** What was booked, kept with the invoice in website-invoices.jsonl (for the member's dashboard). */
  booking?: Booked;
}): Promise<{ ok: true; invoice: Invoice } | { ok: false; error: string; status: number }> {
  const target = await invoicePartner(odoo, p);
  if (!target.ok) return target;
  const partnerId = target.partnerId;
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
  return { ok: true, invoice: await finishInvoice(odoo, moveId, { guildId: p.guildId, userId: p.userId, partnerId, booking: p.booking }) };
}

/**
 * Who an invoice goes to: the member themselves (their partner, created with their email when
 * Odoo has none), or one of their organisations (added by them, or the company Odoo has them as a
 * contact of).
 */
export async function invoicePartner(odoo: OdooCall, p: { guildId: string; userId: string; member: { name: string; email?: string }; to: number | "self" }): Promise<{ ok: true; partnerId: number } | { ok: false; error: string; status: number }> {
  if (p.to === "self") {
    const me = await selfPartner(odoo, p.member.email);
    if (me) return { ok: true, partnerId: me.id };
    if (p.member.email) return { ok: true, partnerId: ((await odoo("res.partner", "create", { vals_list: [{ name: p.member.name, email: p.member.email, lang: DEFAULT_LANG }] })) as number[])[0] };
    return { ok: false, error: "We don't have your email address: add an organisation to invoice instead.", status: 400 };
  }
  const mine = await userOrgIds(p.guildId, p.userId);
  const me = await selfPartner(odoo, p.member.email);
  if (!mine.includes(p.to) && p.to !== me?.id && p.to !== companyIdOf(me)) return { ok: false, error: "Choose one of your organisations.", status: 403 };
  return { ok: true, partnerId: p.to };
}

/** A posted invoice: emailed, kept in website-invoices.jsonl (so the member can pay it by card), as the website shows it. */
export async function finishInvoice(odoo: OdooCall, moveId: number, p: { guildId: string; userId: string; partnerId: number; booking?: Booked }): Promise<Invoice> {
  const [m] = (await odoo("account.move", "read", {
    ids: [moveId],
    fields: ["name", "amount_untaxed", "amount_tax", "amount_total", "payment_reference", "invoice_date_due", "partner_id"],
  })) as { name: string; amount_untaxed: number; amount_tax: number; amount_total: number; payment_reference: string | false; invoice_date_due: string | false; partner_id: [number, string] }[];
  const [partner] = (await odoo("res.partner", "read", { ids: [p.partnerId], fields: ["email"] })) as { email: string | false }[];
  const emailed = await emailInvoice(odoo, moveId);
  const path = invoicesFile(p.guildId);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify({ invoiceId: moveId, number: m.name, userId: p.userId, total: m.amount_total, communication: s(m.payment_reference) || m.name, ...(p.booking ? { booking: p.booking } : {}), at: new Date().toISOString() }) + "\n", { append: true });
  return {
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
  };
}
