/**
 * The one way to report a transaction (euros or tokens) in Discord.
 *
 * Every report ends with "🏷️ Category: …" and the steward-only category dropdown. The transactions
 * behind a report are identified by URI, as chb does:
 *   ethereum:<chainId>:tx:<0x hash>  (tokens, EURe, EURb…)
 *   stripe:txn_…                    (Stripe balance transactions)
 *   iban:<iban>:tx:<line id>        (bank)
 * A report is recorded per guild (DATA_DIR/<guild>/tx-reports.json): message → URIs and currency
 * (for the dropdown), and URI → message (so the same transaction is never reported twice).
 *
 * Used by the bot's own posts (mints, sends, burns, bookings, shift rewards) and by other bots
 * through POST /api/transactions/report.
 */
import type { Client, Message, MessageCreateOptions, TextChannel } from "discord.js";
import { getEnv, loadGuildSettings } from "./utils.ts";
import { categoryLine, categoryMenu, DEFAULT_CATEGORY } from "./tx-categories.ts";

export const REPORT_SELECT_ID = "txcat:r";
export const DEFAULT_REPORT_GUILD = "1280532848604086365";

export type TxReportRecord = {
  guildId: string;
  channelId: string;
  messageId: string;
  url: string;
  uris: string[];
  currency: string;
  category?: string;
  setBy?: string;
  createdAt: string;
};

type Store = { messages: Record<string, TxReportRecord>; uris: Record<string, string> };

const dataDir = () => getEnv("DATA_DIR") || "/data";
const storePath = (guildId: string) => `${dataDir()}/${guildId}/tx-reports.json`;
const cache = new Map<string, Store>();
const locks = new Map<string, Promise<unknown>>();

async function load(guildId: string): Promise<Store> {
  const cached = cache.get(guildId);
  if (cached) return cached;
  let store: Store = { messages: {}, uris: {} };
  try {
    store = JSON.parse(await Deno.readTextFile(storePath(guildId)));
  } catch {
    // first report in this guild
  }
  cache.set(guildId, store);
  return store;
}

function locked<T>(guildId: string, fn: (s: Store) => T | Promise<T>, write = true): Promise<T> {
  const next = (locks.get(guildId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const store = await load(guildId);
    const result = await fn(store);
    if (write) {
      await Deno.mkdir(`${dataDir()}/${guildId}`, { recursive: true });
      await Deno.writeTextFile(storePath(guildId), JSON.stringify(store));
    }
    return result;
  });
  locks.set(guildId, next);
  return next;
}

const normUri = (uri: string) => (uri.toLowerCase().startsWith("ethereum:") ? uri.toLowerCase() : uri.trim());

export function findReportByUri(guildId: string, uri: string): Promise<TxReportRecord | undefined> {
  return locked(guildId, (s) => {
    const id = s.uris[normUri(uri)];
    return id ? s.messages[id] : undefined;
  }, false);
}

export function findReportByMessage(guildId: string, messageId: string): Promise<TxReportRecord | undefined> {
  return locked(guildId, (s) => s.messages[messageId], false);
}

export function updateReportCategory(guildId: string, messageId: string, category: string, setBy: string): Promise<void> {
  return locked(guildId, (s) => {
    const r = s.messages[messageId];
    if (r) Object.assign(r, { category, setBy });
  });
}

/** For tests. */
export function _resetReportCache() {
  cache.clear();
  locks.clear();
}

// ── Formatting (for reports coming through the API) ─────────────────────────

export type TxReportFields = {
  uri: string;
  amount: number;
  currency: string;
  direction: "in" | "out";
  counterparty?: string;
  description?: string;
  links?: { label: string; url: string }[];
  occurredAt?: string;
};

export const isEuro = (currency: string) => /^(eur|€)/i.test(currency.trim());

/** "€12.50" for euros, "12.5 CHT" for tokens. */
export function formatMoney(amount: number, currency: string): string {
  if (isEuro(currency)) {
    const s = amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency.trim().toUpperCase() === "EUR" || currency.trim() === "€" ? `€${s}` : `€${s} (${currency.trim()})`;
  }
  return `${Number(amount.toFixed(6))} ${currency.trim()}`;
}

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The standard text of a transaction report (without the category line, added when posting). */
export function formatTransactionReport(f: TxReportFields): string {
  const verb = f.direction === "in" ? "💰 Received" : "💸 Sent";
  const who = f.counterparty ? ` ${f.direction === "in" ? "from" : "to"} ${clean(f.counterparty, 200)}` : "";
  const when = f.occurredAt && !isNaN(Date.parse(f.occurredAt)) ? ` · <t:${Math.floor(Date.parse(f.occurredAt) / 1000)}:f>` : "";
  const lines = [`${verb} **${formatMoney(f.amount, f.currency)}**${who}${when}`];
  if (f.description) lines.push(`📝 ${clean(f.description, 500)}`);
  const links = (f.links ?? []).filter((l) => /^https?:\/\/\S+$/.test(l.url)).slice(0, 5);
  if (links.length) lines.push(`🔗 ${links.map((l) => `[${clean(l.label, 60)}](<${l.url}>)`).join(" · ")}`);
  return lines.join("\n");
}

// ── Where to post ───────────────────────────────────────────────────────────

/** The token's own transactions channel; euros go to the euro tokens' channel; else the guild's. */
export async function defaultReportChannel(guildId: string, currency: string): Promise<string | undefined> {
  const settings = await loadGuildSettings(guildId);
  if (!settings) return undefined;
  const c = currency.trim().toLowerCase();
  const token = settings.tokens.find((t) => t.symbol.toLowerCase() === c && t.transactionsChannelId);
  if (token) return token.transactionsChannelId;
  if (isEuro(currency)) {
    const eur = settings.tokens.find((t) => /^eur/i.test(t.symbol) && t.transactionsChannelId);
    if (eur) return eur.transactionsChannelId;
  }
  return settings.channels?.transactions || undefined;
}

// ── Posting ─────────────────────────────────────────────────────────────────

/**
 * Post a transaction report with the category line and dropdown, and record it. When the first URI
 * was already reported in this guild, nothing is posted and the existing report is returned.
 */
export async function reportTransaction(p: {
  client: Client;
  channelId: string;
  content: string;
  uris: string[];
  currency: string;
  category?: string;
  /** Mentions in `content` ping by default (the bot's own posts); pass { parse: [] } for external text. */
  allowedMentions?: MessageCreateOptions["allowedMentions"];
}): Promise<{ message?: Message; url: string; record: TxReportRecord; alreadyReported: boolean }> {
  const channel = await p.client.channels.fetch(p.channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel) || !("guildId" in channel) || !channel.guildId) {
    throw new Error(`Channel ${p.channelId} is not a server text channel or thread the bot can see`);
  }
  const guildId = channel.guildId;
  const uris = [...new Set(p.uris.map(normUri))];
  if (uris.length === 0) throw new Error("A report needs at least one transaction URI");

  const existing = await findReportByUri(guildId, uris[0]);
  if (existing) return { url: existing.url, record: existing, alreadyReported: true };

  const category = p.category || DEFAULT_CATEGORY;
  const message = await (channel as TextChannel).send({
    content: `${p.content}\n${categoryLine(category, p.currency)}`,
    components: [categoryMenu(REPORT_SELECT_ID, p.currency, category)],
    ...(p.allowedMentions ? { allowedMentions: p.allowedMentions } : {}),
  });
  const record: TxReportRecord = {
    guildId,
    channelId: message.channelId,
    messageId: message.id,
    url: message.url,
    uris,
    currency: p.currency,
    category,
    createdAt: new Date().toISOString(),
  };
  await locked(guildId, (s) => {
    s.messages[message.id] = record;
    for (const uri of uris) s.uris[uri] ??= message.id;
  });
  return { message, url: message.url, record, alreadyReported: false };
}
