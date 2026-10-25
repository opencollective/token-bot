/**
 * Things members can buy with their tokens (/buy, and propose_purchase for Elinor).
 *
 * A purchase burns the price from the buyer's own account, never someone else's, then:
 * - annotates the burn on Nostr (community relay first) with category, item and buyer, as chb reads it;
 * - posts the standard transaction report, with the item's category, in the token's transactions channel.
 *
 * To sell something new, add a line to SHOP_ITEMS and a choice to /buy in src/commands.json.
 */
import { Client } from "discord.js";
import { formatUnits, parseUnits } from "@wevm/viem";
import { burnTokensFrom, parseInsufficientGasError, type SupportedChain } from "./blockchain.ts";
import { getSenderBalance } from "./send.ts";
import { tokenTag, txUrlFor } from "./mint.ts";
import { Nostr, type URI } from "./nostr.ts";
import { txUriFor } from "./tx-categories.ts";
import { reportTransaction } from "./tx-reports.ts";
import { refreshTokenStats } from "./token-stats-cache.ts";
import type { GuildSettings, Token } from "../types.ts";
import { COWORKING_TOKEN_TERMS } from "./token-terms.ts";

/** `terms`: what paying with tokens gets you; not the same service as paying in euros (see token-terms.ts). */
export type ShopItem = { id: string; label: string; price: number; category: string; terms: string };

/**
 * Prices are in the community token (CHT). People read "tokens", never the symbol (Xavier's rule).
 * Contributor coworking is for today: an idle desk, no reservation (COWORKING_TOKEN_TERMS).
 */
export const SHOP_ITEMS: ShopItem[] = [
  { id: "coworking-day", label: "Contributor coworking day", price: 2, category: "coworking", terms: COWORKING_TOKEN_TERMS },
  { id: "coworking-half-day", label: "Contributor coworking half day", price: 1, category: "coworking", terms: COWORKING_TOKEN_TERMS },
];

/** Bought with /buy or propose_purchase, an item is for today: there's no advance reservation. */
export const FOR_TODAY = "For today: there's no advance reservation.";

/** The fine print under anything that offers or confirms these items: "For today… <terms>". */
export function itemsFinePrint(items: ShopItem[] = SHOP_ITEMS): string {
  return [FOR_TODAY, ...new Set(items.map((i) => i.terms))].join(" ");
}

export const SHOP_TOKEN_SYMBOL = "CHT";

/** Labels before "Contributor …", still understood. */
const OLD_LABELS: Record<string, string> = { "coworking-day": "coworking day", "coworking-half-day": "half day coworking" };

export function findShopItem(input: string): ShopItem | undefined {
  const wanted = input.trim().toLowerCase();
  return SHOP_ITEMS.find((i) => i.id === wanted || i.label.toLowerCase() === wanted || OLD_LABELS[i.id] === wanted);
}

/** The token prices are in: CHT, else the guild's only mintable token. */
export function shopToken(settings: GuildSettings | null | undefined): Token | null {
  const tokens = settings?.tokens ?? [];
  const cht = tokens.find((t) => t.symbol.toUpperCase() === SHOP_TOKEN_SYMBOL);
  if (cht) return cht;
  const mintable = tokens.filter((t) => t.mintable);
  return mintable.length === 1 ? mintable[0] : null;
}

export const CLAIM_HINT = "You can /claim tokens for a contribution.";

/** "1 token", "2 tokens", "1.5 tokens". */
export const tokens = (n: number) => `${n} token${n === 1 ? "" : "s"}`;

export function itemLine(item: ShopItem): string {
  return `${item.label} (${tokens(item.price)})`;
}

const clean = (s: string | undefined) => s?.replace(/\s+/g, " ").trim().slice(0, 300) || undefined;

/** The Nostr annotation of a purchase burn (category as chb reads it; the buyer's Discord id in a tag). */
export function purchaseAnnotation(item: ShopItem, token: Token, buyer: { id: string; name: string }, description?: string, via = "command") {
  const d = clean(description);
  return {
    content: `${item.label} for ${buyer.name}${d ? `: ${d}` : ""}`,
    tags: [
      ["t", "burn"],
      ["t", "purchase"],
      ["t", item.id],
      ["category", item.category],
      ["amount", String(item.price)],
      ["token", tokenTag(token)],
      ["buyer", `discord:${buyer.id}`],
      ["via", via],
    ],
  };
}

export function purchaseReport(item: ShopItem, token: Token, buyerId: string, hash: string, description?: string): string {
  const d = clean(description);
  return `🛒 <@${buyerId}> bought a **${item.label}** for [${tokens(item.price)}](<https://txinfo.xyz/${token.chain}/token/${token.address}>) [[tx]](<${txUrlFor(token, hash)}>)` +
    (d ? `\n📝 ${d}` : "") + `\n-# ${item.terms}`;
}

// ── Balance and burn (replaceable in tests) ─────────────────────────────────

type Deps = {
  balanceOf(userId: string, token: Token): Promise<{ address: string; balance: bigint } | null>;
  burn(token: Token, userId: string, address: string, amount: number): Promise<string | null>;
  annotate(uri: URI, annotation: { content: string; tags: string[][] }): Promise<unknown>;
  refreshStats(token: Token): Promise<void>;
};

async function burnFromUser(token: Token, userId: string, address: string, amount: number): Promise<string | null> {
  if (token.walletManager === "citizenwallet") {
    return await burnTokensFrom(token.chain as SupportedChain, token.address, address, amount.toString(), token.decimals);
  }
  const { Token: OCToken } = await import("@opencollective/token-factory");
  const oc = new OCToken({ name: token.name, symbol: token.symbol, chain: token.chain, tokenAddress: token.address });
  return await oc.burnFrom(parseUnits(amount.toFixed(token.decimals), token.decimals), `discord:${userId}`);
}

const DEFAULT_DEPS: Deps = {
  balanceOf: getSenderBalance,
  burn: burnFromUser,
  annotate: (uri, annotation) => Nostr.getInstance().publishMetadata(uri, annotation),
  refreshStats: (token) => refreshTokenStats(token.chain, token.address, token.decimals),
};
let deps: Deps = DEFAULT_DEPS;

/** For tests. */
export function _setShopDeps(next?: Partial<Deps>) {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
}

export type BalanceCheck = { ok: boolean; balance: number; address?: string; message?: string };

/** Can this user pay for the item? `message` says why not. */
export async function checkBalance(userId: string, token: Token, item: ShopItem): Promise<BalanceCheck> {
  const found = await deps.balanceOf(userId, token);
  if (!found) return { ok: false, balance: 0, message: `No token account found for <@${userId}>.` };
  const balance = Number(formatUnits(found.balance, token.decimals));
  if (found.balance < parseUnits(item.price.toFixed(token.decimals), token.decimals)) {
    return {
      ok: false,
      balance,
      address: found.address,
      message: `Not enough tokens: a ${item.label} costs ${tokens(item.price)} and the balance is ${tokens(balance)}. ${CLAIM_HINT}` +
        (token.mintInstructions ? `\n${token.mintInstructions}` : ""),
    };
  }
  return { ok: true, balance, address: found.address };
}

/**
 * Burn `amount` from a member's own account after checking their balance (what a room booking
 * paid with tokens does). Nothing is burned when the balance is short; `error` says why.
 */
export async function burnFromMember(userId: string, token: Token, amount: number, what: string): Promise<{ ok: true; hash: string; balanceAfter: number } | { ok: false; error: string }> {
  const found = await deps.balanceOf(userId, token);
  if (!found) return { ok: false, error: "No token account found for you: ask a steward to set up your wallet." };
  const balance = Number(formatUnits(found.balance, token.decimals));
  if (found.balance < parseUnits(amount.toFixed(token.decimals), token.decimals)) {
    return { ok: false, error: `Not enough tokens: ${what} costs ${tokens(amount)} and your balance is ${tokens(balance)}. ${CLAIM_HINT}` };
  }
  let hash: string | null;
  try {
    hash = await deps.burn(token, userId, found.address, amount);
  } catch (error) {
    console.error(`[shop] burn failed for ${userId} (${what}):`, error);
    const gas = await parseInsufficientGasError(error, token.chain as SupportedChain).catch(() => null);
    return { ok: false, error: gas ? gas.formatMessage("burn") : "The payment failed; nothing was charged. Please try again in a moment." };
  }
  if (!hash) return { ok: false, error: "The payment returned no transaction; nothing was charged." };
  deps.refreshStats(token).catch(() => {});
  return { ok: true, hash, balanceAfter: Number((balance - amount).toFixed(6)) };
}

export type PurchaseResult =
  | { ok: true; hash: string; txUri: string; balanceAfter: number; reportUrl?: string }
  | { ok: false; error: string };

/** Burn the price from the buyer's own account, annotate it, report it. Checks the balance first. */
export async function executePurchase(p: {
  client: Client;
  guildSettings: GuildSettings;
  token: Token;
  item: ShopItem;
  buyer: { id: string; name: string };
  description?: string;
  via?: "command" | "elinor" | "website";
}): Promise<PurchaseResult> {
  const { token, item, buyer } = p;
  const check = await checkBalance(buyer.id, token, item);
  if (!check.ok || !check.address) return { ok: false, error: check.message ?? "Balance check failed" };

  let hash: string | null;
  try {
    hash = await deps.burn(token, buyer.id, check.address, item.price);
  } catch (error) {
    console.error(`[shop] burn failed for ${buyer.id} (${item.id}):`, error);
    const gas = await parseInsufficientGasError(error, token.chain as SupportedChain).catch(() => null);
    return { ok: false, error: gas ? gas.formatMessage("burn") : error instanceof Error ? error.message : String(error) };
  }
  if (!hash) return { ok: false, error: "The burn returned no transaction hash; nothing was charged." };
  const txUri = txUriFor(token.chain, hash);

  try {
    await deps.annotate(txUri as URI, purchaseAnnotation(item, token, buyer, p.description, p.via));
  } catch (error) {
    console.error(`[shop] Nostr annotation failed for ${hash}:`, error);
  }

  let reportUrl: string | undefined;
  const channelId = token.transactionsChannelId || p.guildSettings.channels?.transactions;
  if (channelId) {
    try {
      const report = await reportTransaction({
        client: p.client,
        channelId,
        content: purchaseReport(item, token, buyer.id, hash, p.description),
        uris: [txUri],
        currency: token.symbol,
        category: item.category,
        allowedMentions: { users: [buyer.id] },
      });
      reportUrl = report.url;
    } catch (error) {
      console.error("[shop] could not post the transaction report:", error);
    }
  }
  deps.refreshStats(token).catch(() => {});
  return { ok: true, hash, txUri, balanceAfter: Number((check.balance - item.price).toFixed(6)), reportUrl };
}
