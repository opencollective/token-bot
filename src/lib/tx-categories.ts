/**
 * Transaction categories: the lists, who may change them, and the dropdown on transaction reports.
 *
 * Token (CHT) categories are the contribution types Xavier listed, plus "rental" for room bookings
 * paid in tokens (already annotated so). Euro-token (EURb, EURchb…) categories are chb's
 * (settings/categories.json); the Discord dropdown shows at most 25 options, so it offers the
 * common ones and the MCP tool accepts all of them.
 */
import {
  ActionRowBuilder,
  GuildMember,
  PermissionsBitField,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { ChainConfig, type SupportedChain } from "./blockchain.ts";

export type Category = { slug: string; label: string };

export const TOKEN_CATEGORIES: Category[] = [
  { slug: "governance", label: "Governance" },
  { slug: "cleaning", label: "Cleaning" },
  { slug: "shift", label: "Shift" },
  { slug: "note-taking", label: "Note taking" },
  { slug: "admin", label: "Admin" },
  { slug: "care", label: "Care" },
  { slug: "rental", label: "Room rental" },
  { slug: "none", label: "None" },
];

/** chb's categories (settings/categories.json, Oct 2026). */
export const EURO_CATEGORIES: Category[] = [
  ["membership", "Membership"], ["donation", "Donation"], ["subsidy", "Subsidy"], ["grant", "Grant"],
  ["sponsoring", "Sponsoring"], ["rental", "Room rental"], ["coworking", "Coworking"], ["ticket", "Ticket"],
  ["catering", "Catering"], ["fridge", "Fridge"], ["drinks", "Drinks"], ["coffee", "Coffee"],
  ["other-income", "Other income"], ["rent", "Rent"], ["utilities", "Utilities"], ["maintenance", "Maintenance"],
  ["HR", "Salaries and social charges"], ["consulting", "Consulting and fees"], ["accounting", "Accounting and legal"],
  ["services", "Services"], ["insurance", "Insurance"], ["supplies", "Supplies"], ["equipment", "Equipment"],
  ["furniture", "Furniture and rented equipment"], ["events", "Events and receptions"], ["travel", "Travel"],
  ["marketing", "Marketing"], ["internet", "Telecommunications"], ["webservice", "Web services"], ["taxes", "Taxes"],
  ["vat", "VAT"], ["stripe_fee", "Payment fees"], ["bank_fees", "Bank fees"], ["donations_given", "Donations given"],
  ["exceptional", "Exceptional items"], ["other-expense", "Other expense"], ["expense", "Expense reimbursement"],
  ["debt", "Vouchers and debts"], ["loan", "Loans"], ["internal_transfer", "Internal transfer"],
  ["opening_balance", "Opening balance"], ["accrual", "Previous-year invoices"], ["refund", "Refund"],
  ["none", "None"],
].map(([slug, label]) => ({ slug, label }));

/** The euro categories offered in the Discord dropdown (max 25). */
const EURO_MENU = [
  "rental", "coworking", "membership", "donation", "ticket", "catering", "fridge", "drinks", "coffee",
  "other-income", "rent", "utilities", "maintenance", "supplies", "equipment", "events", "services",
  "expense", "refund", "internal_transfer", "debt", "exceptional", "other-expense", "none",
];

export const isEuroToken = (symbol: string) => /^eur/i.test(symbol);

export function categoriesFor(tokenSymbol: string): Category[] {
  return isEuroToken(tokenSymbol) ? EURO_CATEGORIES : TOKEN_CATEGORIES;
}

export function findCategory(tokenSymbol: string | undefined, slug: string): Category | undefined {
  const pool = tokenSymbol ? categoriesFor(tokenSymbol) : [...TOKEN_CATEGORIES, ...EURO_CATEGORIES];
  return pool.find((c) => c.slug.toLowerCase() === slug.trim().toLowerCase());
}

export function categoryLabel(slug: string | undefined, tokenSymbol?: string): string {
  if (!slug) return "None";
  return findCategory(tokenSymbol, slug)?.label ?? slug;
}

// ── Stewards ────────────────────────────────────────────────────────────────

/** Who may change categories: admins, the token's minters, and anyone with a "… steward" role. */
export function isSteward(member: GuildMember, minterRoleIds: (string | undefined)[] = []): boolean {
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (minterRoleIds.some((id) => id && member.roles.cache.has(id))) return true;
  return member.roles.cache.some((r) => /\bsteward\b/i.test(r.name));
}

// ── The dropdown on transaction reports ─────────────────────────────────────

export const CATEGORY_SELECT_PREFIX = "txcat:";
export const CATEGORY_LINE_RE = /^🏷️ Category: .*$/m;

/** customId: "txcat:<chain>:<token symbol>". The tx hashes are read from the message's tx links. */
export function categorySelectId(chain: string, tokenSymbol: string): string {
  return `${CATEGORY_SELECT_PREFIX}${chain}:${tokenSymbol}`;
}

export function parseCategorySelectId(customId: string): { chain: string; tokenSymbol: string } | null {
  if (!customId.startsWith(CATEGORY_SELECT_PREFIX)) return null;
  const [chain, tokenSymbol] = customId.slice(CATEGORY_SELECT_PREFIX.length).split(":");
  return chain && tokenSymbol ? { chain, tokenSymbol } : null;
}

export function categoryLine(slug: string | undefined, tokenSymbol: string, setBy?: string): string {
  return `🏷️ Category: ${categoryLabel(slug, tokenSymbol)}${setBy ? ` · set by <@${setBy}>` : ""}`;
}

export function categoryMenu(chain: string, tokenSymbol: string, current?: string) {
  const slugs = isEuroToken(tokenSymbol) ? EURO_MENU : TOKEN_CATEGORIES.map((c) => c.slug);
  const options = slugs.map((s) => findCategory(tokenSymbol, s)!).filter(Boolean);
  if (current && !options.some((c) => c.slug === current)) options.unshift({ slug: current, label: categoryLabel(current, tokenSymbol) });
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(categorySelectId(chain, tokenSymbol))
      .setPlaceholder("Change the category (stewards)")
      .addOptions(options.slice(0, 25).map((c) =>
        new StringSelectMenuOptionBuilder().setLabel(c.label).setValue(c.slug).setDefault(c.slug === (current ?? "none"))
      )),
  );
}

/** Add the category line and dropdown to a transaction report. */
export function withCategory(
  content: string,
  p: { chain: string; tokenSymbol: string; category?: string },
): { content: string; components: ActionRowBuilder<StringSelectMenuBuilder>[] } {
  return {
    content: `${content}\n${categoryLine(p.category, p.tokenSymbol)}`,
    components: [categoryMenu(p.chain, p.tokenSymbol, p.category)],
  };
}

/** Swap the category line of a report (adds one if missing). */
export function replaceCategoryLine(content: string, line: string): string {
  return CATEGORY_LINE_RE.test(content) ? content.replace(CATEGORY_LINE_RE, line) : `${content}\n${line}`;
}

/** Tx hashes linked from a report ("…/tx/0x…"), in order, deduped. */
export function txHashesIn(content: string): string[] {
  return [...new Set([...content.matchAll(/\/tx\/(0x[0-9a-fA-F]{64})/g)].map((m) => m[1].toLowerCase()))];
}

export function txUriFor(chain: string, hash: string): string {
  const id = ChainConfig[chain as SupportedChain]?.id;
  if (!id) throw new Error(`Unknown chain ${chain}`);
  return `ethereum:${id}:tx:${hash.toLowerCase()}`;
}
