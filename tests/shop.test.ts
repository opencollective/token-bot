/**
 * /buy and propose_purchase: the catalogue, the balance check, and the purchase itself
 * (burn from the buyer's own account, annotation with the category, transaction report).
 */
import { expect } from "@std/expect/expect";
import commands from "../src/commands.json" with { type: "json" };
import {
  _setShopDeps,
  checkBalance,
  executePurchase,
  findShopItem,
  itemsFinePrint,
  purchaseAnnotation,
  purchaseReport,
  SHOP_ITEMS,
  shopToken,
} from "../src/lib/shop.ts";
import { findCategory } from "../src/lib/tx-categories.ts";
import { getMcpTools } from "../src/mcp/server.ts";
import { COWORKING_TOKEN_TERMS } from "../src/lib/token-terms.ts";
import type { GuildSettings, Token } from "../src/types.ts";

const CHT: Token = {
  name: "Commons Hub Token", symbol: "CHT", decimals: 6, chain: "celo",
  address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d", mintable: true, walletManager: "citizenwallet",
} as Token;
const EUR = { ...CHT, symbol: "EURchb", chain: "gnosis", address: "0x9ee438a16be3c75247aded9c80e801bf4764ca5c" } as Token;
const settings = { guild: { id: "g", name: "G" }, channels: {}, tokens: [EUR, CHT] } as unknown as GuildSettings;
const HASH = "0x" + "ab".repeat(32);
const day = findShopItem("coworking-day")!;
const half = findShopItem("Half day coworking")!;

Deno.test("catalogue: coworking day 2 CHT, half day 1 CHT, both categorized coworking (a token category)", () => {
  expect(SHOP_ITEMS.map((i) => [i.id, i.price, i.category])).toEqual([
    ["coworking-day", 2, "coworking"],
    ["coworking-half-day", 1, "coworking"],
  ]);
  expect(half.id).toBe("coworking-half-day");
  expect(findShopItem("Contributor coworking day")?.id).toBe("coworking-day");
  expect(SHOP_ITEMS.map((i) => i.label)).toEqual(["Contributor coworking day", "Contributor coworking half day"]);
  expect(findShopItem("pizza")).toBeUndefined();
  for (const item of SHOP_ITEMS) expect(findCategory("CHT", item.category)?.slug).toBe(item.category);
});

Deno.test("paying with tokens is not the same service: every item carries the website's terms, and it's for today", () => {
  expect(COWORKING_TOKEN_TERMS).toBe(
    "Contributor coworking (with tokens): use an available desk when capacity is idle; no guaranteed desk, no advance reservation, subject to community activities.",
  );
  for (const item of SHOP_ITEMS) expect(item.terms).toBe(COWORKING_TOKEN_TERMS);
  expect(itemsFinePrint()).toBe(`For today: there's no advance reservation. ${COWORKING_TOKEN_TERMS}`);
  const buy = (commands as { name: string; description: string; options?: { name: string; choices?: { name: string }[] }[] }[]).find((c) => c.name === "buy")!;
  expect(buy.options!.find((o) => o.name === "item")!.choices!.map((c) => c.name)).toEqual([
    "Contributor coworking day (today) — 2 tokens",
    "Contributor coworking half day (today) — 1 token",
  ]);
  const tool = getMcpTools().find((t) => t.name === "propose_purchase")!;
  expect(tool.description).toContain("no guaranteed desk, no advance reservation");
});

Deno.test("/buy offers exactly the catalogue's items", () => {
  const buy = (commands as { name: string; options?: { name: string; choices?: { value: string }[] }[] }[]).find((c) => c.name === "buy")!;
  expect(buy.options!.find((o) => o.name === "item")!.choices!.map((c) => c.value)).toEqual(SHOP_ITEMS.map((i) => i.id));
});

Deno.test("propose_purchase's item enum is the catalogue", () => {
  const tool = getMcpTools().find((t) => t.name === "propose_purchase")!;
  expect((tool.inputSchema.properties as { item: { enum: string[] } }).item.enum).toEqual(SHOP_ITEMS.map((i) => i.id));
});

Deno.test("prices are in CHT, else the only mintable token", () => {
  expect(shopToken(settings)?.symbol).toBe("CHT");
  expect(shopToken({ ...settings, tokens: [EUR] } as GuildSettings)?.symbol).toBe("EURchb");
  expect(shopToken({ ...settings, tokens: [] } as unknown as GuildSettings)).toBeNull();
});

Deno.test("annotation and report: category, item, buyer, description", () => {
  const a = purchaseAnnotation(day, CHT, { id: "42", name: "Ana" }, "  Monday\n desk ", "elinor");
  expect(a.content).toBe("Contributor coworking day for Ana: Monday desk");
  expect(a.tags).toEqual([
    ["t", "burn"], ["t", "purchase"], ["t", "coworking-day"], ["category", "coworking"], ["amount", "2"],
    ["token", "ethereum:42220:address:0x65dd32834927de9e57e72a3e2130a19f81c6371d"], ["buyer", "discord:42"], ["via", "elinor"],
  ]);
  const r = purchaseReport(half, CHT, "42", HASH);
  expect(r).toContain("🛒 <@42> bought a **Contributor coworking half day** for [1 token](");
  expect(r).toContain(`\n-# ${COWORKING_TOKEN_TERMS}`);
  expect(r).not.toContain("CHT");
  expect(r).toContain(`https://txinfo.xyz/celo/tx/${HASH}`);
});

function stubs(balance: bigint | null) {
  const calls = { burns: [] as unknown[][], annotations: [] as unknown[][] };
  _setShopDeps({
    balanceOf: (userId) => Promise.resolve(balance === null ? null : { address: `0xaddr-${userId}`, balance }),
    burn: (token, userId, address, amount) => {
      calls.burns.push([token.symbol, userId, address, amount]);
      return Promise.resolve(HASH);
    },
    annotate: (uri, a) => {
      calls.annotations.push([uri, a]);
      return Promise.resolve();
    },
    refreshStats: () => Promise.resolve(),
  });
  return calls;
}

// deno-lint-ignore no-explicit-any
const client = {} as any;

Deno.test("checkBalance: too low or no account explains why", async () => {
  try {
    stubs(1_500_000n);
    expect(await checkBalance("42", CHT, half)).toMatchObject({ ok: true, balance: 1.5 });
    const low = await checkBalance("42", CHT, day);
    expect(low.ok).toBe(false);
    expect(low.message).toContain("Not enough tokens: a Contributor coworking day costs 2 tokens and the balance is 1.5 tokens");
    expect(low.message).toContain("You can /claim tokens for a contribution.");
    stubs(null);
    expect((await checkBalance("42", CHT, day)).message).toContain("No token account found");
  } finally {
    _setShopDeps();
  }
});

Deno.test("executePurchase burns the price from the buyer's own account, then annotates it", async () => {
  try {
    const calls = stubs(5_000_000n);
    const res = await executePurchase({ client, guildSettings: settings, token: CHT, item: day, buyer: { id: "42", name: "Ana" }, description: "Tuesday" });
    expect(res).toMatchObject({ ok: true, hash: HASH, txUri: `ethereum:42220:tx:${HASH}`, balanceAfter: 3 });
    expect(calls.burns).toEqual([["CHT", "42", "0xaddr-42", 2]]);
    expect(calls.annotations[0][0]).toBe(`ethereum:42220:tx:${HASH}`);
    expect((calls.annotations[0][1] as { tags: string[][] }).tags).toContainEqual(["category", "coworking"]);
  } finally {
    _setShopDeps();
  }
});

Deno.test("executePurchase: nothing is burned when the balance is too low; burn errors are reported", async () => {
  try {
    const calls = stubs(1_000_000n);
    const res = await executePurchase({ client, guildSettings: settings, token: CHT, item: day, buyer: { id: "42", name: "Ana" } });
    expect(res.ok).toBe(false);
    expect(calls.burns).toEqual([]);

    _setShopDeps({
      balanceOf: () => Promise.resolve({ address: "0xa", balance: 9_000_000n }),
      burn: () => Promise.reject(new Error("bundler down")),
      refreshStats: () => Promise.resolve(),
    });
    expect(await executePurchase({ client, guildSettings: settings, token: CHT, item: half, buyer: { id: "42", name: "Ana" } }))
      .toEqual({ ok: false, error: "bundler down" });
  } finally {
    _setShopDeps();
  }
});
