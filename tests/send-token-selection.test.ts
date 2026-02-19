/**
 * /send token selection flow tests
 *
 * Verifies:
 * - Skips token selection when only 1 token has positive balance
 * - Shows token picker when 2+ tokens have positive balance
 * - Shows error when no tokens have balance
 */

import { expect } from "@std/expect/expect";
import type { Token } from "../src/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const chtToken: Token = {
  name: "Commons Hub Token", symbol: "CHT", decimals: 6,
  chain: "celo", address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d",
  mintable: true, transactionsChannelId: "1354115945718878269",
};

const eurchbToken: Token = {
  name: "EURchb", symbol: "EURchb", decimals: 6,
  chain: "gnosis", address: "0x5815E61eF72c9E6107b5c5A05FD121F334f7a7f1",
  mintable: false, transactionsChannelId: "1372518467323826259",
};

const tstToken: Token = {
  name: "Test Token", symbol: "TST", decimals: 18,
  chain: "base", address: "0x0000000000000000000000000000000000000001",
  mintable: true,
};

// ── Mock interaction tracking ───────────────────────────────────────────────

type FlowResult =
  | { type: "confirmation"; tokenIndex: number; token: Token }
  | { type: "token_picker"; tokenIndices: number[] }
  | { type: "error"; message: string };

/**
 * Mirrors the token selection logic from handleSendCommand.
 * Extracted so we can test without Discord.js / blockchain dependencies.
 */
function determineSendFlow(
  tokens: Token[],
  balances: Map<number, bigint>,
): FlowResult {
  const tokensWithBalance: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const balance = balances.get(i) ?? 0n;
    if (balance > 0n) tokensWithBalance.push(i);
  }

  if (tokensWithBalance.length === 0) {
    return { type: "error", message: "no balance" };
  }

  if (tokensWithBalance.length === 1) {
    const idx = tokensWithBalance[0];
    return { type: "confirmation", tokenIndex: idx, token: tokens[idx] };
  }

  return { type: "token_picker", tokenIndices: tokensWithBalance };
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test("skips token selection when only 1 token has positive balance", () => {
  const tokens = [chtToken, eurchbToken, tstToken];
  const balances = new Map<number, bigint>([
    [0, 1000000n],  // CHT: 1.0
    [1, 0n],         // EURchb: 0
    [2, 0n],         // TST: 0
  ]);

  const result = determineSendFlow(tokens, balances);

  expect(result.type).toBe("confirmation");
  if (result.type === "confirmation") {
    expect(result.tokenIndex).toBe(0);
    expect(result.token.symbol).toBe("CHT");
  }
});

Deno.test("shows token picker when 2 tokens have positive balance", () => {
  const tokens = [chtToken, eurchbToken, tstToken];
  const balances = new Map<number, bigint>([
    [0, 1000000n],    // CHT: 1.0
    [1, 5000000n],    // EURchb: 5.0
    [2, 0n],           // TST: 0
  ]);

  const result = determineSendFlow(tokens, balances);

  expect(result.type).toBe("token_picker");
  if (result.type === "token_picker") {
    expect(result.tokenIndices).toEqual([0, 1]);
  }
});

Deno.test("shows token picker when all tokens have positive balance", () => {
  const tokens = [chtToken, eurchbToken, tstToken];
  const balances = new Map<number, bigint>([
    [0, 1000000n],
    [1, 5000000n],
    [2, 1000000000000000000n], // 1.0 with 18 decimals
  ]);

  const result = determineSendFlow(tokens, balances);

  expect(result.type).toBe("token_picker");
  if (result.type === "token_picker") {
    expect(result.tokenIndices).toEqual([0, 1, 2]);
  }
});

Deno.test("returns error when no tokens have balance", () => {
  const tokens = [chtToken, eurchbToken];
  const balances = new Map<number, bigint>([
    [0, 0n],
    [1, 0n],
  ]);

  const result = determineSendFlow(tokens, balances);

  expect(result.type).toBe("error");
});

Deno.test("skips token selection with second token having balance (not first)", () => {
  const tokens = [chtToken, eurchbToken];
  const balances = new Map<number, bigint>([
    [0, 0n],         // CHT: 0
    [1, 5000000n],   // EURchb: 5.0
  ]);

  const result = determineSendFlow(tokens, balances);

  expect(result.type).toBe("confirmation");
  if (result.type === "confirmation") {
    expect(result.tokenIndex).toBe(1);
    expect(result.token.symbol).toBe("EURchb");
  }
});

Deno.test("handles missing balance entries (defaults to 0)", () => {
  const tokens = [chtToken, eurchbToken];
  // Only CHT has an entry in the balances map
  const balances = new Map<number, bigint>([
    [0, 500000n],
  ]);

  const result = determineSendFlow(tokens, balances);

  expect(result.type).toBe("confirmation");
  if (result.type === "confirmation") {
    expect(result.tokenIndex).toBe(0);
    expect(result.token.symbol).toBe("CHT");
  }
});

Deno.test("single token in guild skips selection", () => {
  const tokens = [chtToken];
  const balances = new Map<number, bigint>([[0, 1000000n]]);

  const result = determineSendFlow(tokens, balances);

  expect(result.type).toBe("confirmation");
  if (result.type === "confirmation") {
    expect(result.tokenIndex).toBe(0);
  }
});
