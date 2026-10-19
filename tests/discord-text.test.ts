/** Discord's 2000-character limit: results for many recipients must still fit (Heartbeat 108, 10 people). */
import { expect } from "@std/expect/expect";
import { clip, DISCORD_MAX, txLines, txSummary } from "../src/lib/discord-text.ts";
import { formatMintResults, type MintResult } from "../src/lib/mint.ts";
import type { Token } from "../src/types.ts";

const CHT = {
  name: "Commons Hub Token", symbol: "CHT", decimals: 6, chain: "celo",
  address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d", mintable: true,
} as Token;
const hash = (i: number) => "0x" + i.toString(16).padStart(64, "0");
const people = (n: number) => Array.from({ length: n }, (_, i) => `<@${4000000000000000000n + BigInt(i)}>`);
const items = (n: number) => people(n).map((label, i) => ({ label, url: `https://txinfo.xyz/celo/tx/${hash(i)}` }));

Deno.test("clip: short text unchanged, long text cut at a line or word, ending with …", () => {
  expect(clip("hello")).toBe("hello");
  const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const c = clip(long);
  expect(c.length).toBeLessThanOrEqual(DISCORD_MAX);
  expect(c.endsWith("…")).toBe(true);
  expect(long.startsWith(c.slice(0, -1))).toBe(true);
  expect(clip("x".repeat(50), 10)).toBe("x".repeat(9) + "…");
});

Deno.test("txLines: a line per tx while it fits, else one line with everyone and numbered links", () => {
  expect(txLines("✅ Minted 1 token for", items(2))).toBe(
    `✅ Minted 1 token for ${people(2)[0]} [[tx]](<${items(2)[0].url}>)\n✅ Minted 1 token for ${people(2)[1]} [[tx]](<${items(2)[1].url}>)`,
  );
  const ten = txLines("✅ Minted 1 token for", items(10), 1200);
  expect(ten.length).toBeLessThanOrEqual(1200);
  expect(ten.split("\n").length).toBe(1);
  for (const p of people(10)) expect(ten).toContain(p);
});

Deno.test("txSummary: all links or none, never a partial list", () => {
  const all = txSummary("Minted 1 token for", items(3));
  expect(all).toContain(" · txs: [1](<");
  expect(all).toContain(`[3](<${items(3)[2].url}>)`);
  const none = txSummary("Minted 1 token for", items(20), 900);
  expect(none.endsWith(" · 20 txs")).toBe(true);
  for (const p of people(20)) expect(none).toContain(p);
});

Deno.test("formatMintResults: 1, 10 and 20 recipients, with failures, always within the limit", () => {
  const results = (n: number, failed = 0): MintResult[] =>
    people(n).map((label, i) => ({
      recipient: { type: "discord", id: label.slice(2, -1), label, accountId: `discord:${label.slice(2, -1)}` },
      ...(i < n - failed ? { success: true, hash: hash(i) } : { success: false, error: "Insufficient gas: ".repeat(10) }),
    }) as MintResult);
  const desc = "Heartbeat 108 attendance on 2026-10-19: Xavier, Miriam, Friedger, Alain, Cedric, Mathieu, Greet, Dean, Flo, Ben";
  expect(formatMintResults(results(1), CHT, 1, desc)).toContain("[[tx]](<https://");
  for (const [n, failed] of [[10, 0], [20, 0], [20, 5]]) {
    const text = formatMintResults(results(n, failed), CHT, 1, desc, DISCORD_MAX - 800);
    expect(text.length).toBeLessThanOrEqual(DISCORD_MAX - 800);
    for (const p of people(n - failed)) expect(text).toContain(p);
    expect(text).toContain("📝 Heartbeat 108");
    if (failed) expect(text).toContain("❌ Failed to mint for:");
  }
});
