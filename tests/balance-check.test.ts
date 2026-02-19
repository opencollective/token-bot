/**
 * Balance check integration test
 *
 * Verifies that address resolution and balance fetching works for
 * Xavier's Discord user across all configured tokens/chains.
 *
 * Requires network access (RPC calls to Celo and Gnosis).
 *
 * NOTE: These are integration tests that hit real RPCs. They verify
 * that the address resolution + balance check pipeline works end-to-end.
 */

import { expect } from "@std/expect/expect";
import { getAccountAddressForToken } from "../src/lib/citizenwallet.ts";
import { getBalance, SupportedChain } from "../src/lib/blockchain.ts";
import type { Token } from "../src/types.ts";

const XAVIER_DISCORD_ID = "689614876515237925";

const chtToken: Token = {
  name: "Commons Hub Token",
  symbol: "CHT",
  decimals: 6,
  chain: "celo",
  address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d",
  mintable: true,
  // Uses default CardManager on Celo
};

const eurchbToken: Token = {
  name: "EURchb",
  symbol: "EURchb",
  decimals: 6,
  chain: "gnosis",
  address: "0x5815E61eF72c9E6107b5c5A05FD121F334f7a7f1",
  mintable: false,
  // Uses default CardManager on Celo (same address, different chain for balance)
  // If a different CardManager is needed for Gnosis, set cardManagerAddress here
};

Deno.test("resolves Xavier's address for CHT (Celo)", async () => {
  const address = await getAccountAddressForToken(XAVIER_DISCORD_ID, chtToken);
  console.log(`[test] Xavier CHT address: ${address}`);
  expect(address).toBeTruthy();
  expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
});

Deno.test("Xavier has positive CHT balance", async () => {
  const address = await getAccountAddressForToken(XAVIER_DISCORD_ID, chtToken);
  expect(address).toBeTruthy();

  const balance = await getBalance(chtToken.chain as SupportedChain, chtToken.address, address!);
  console.log(`[test] Xavier CHT balance: ${balance.toString()} (${Number(balance) / 1e6} CHT)`);
  expect(balance).toBeGreaterThan(0n);
});

Deno.test("resolves Xavier's address for EURchb", async () => {
  const address = await getAccountAddressForToken(XAVIER_DISCORD_ID, eurchbToken);
  console.log(`[test] Xavier EURchb address: ${address}`);
  expect(address).toBeTruthy();
  expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
});

Deno.test("Xavier has positive EURchb balance on Gnosis", async () => {
  const address = await getAccountAddressForToken(XAVIER_DISCORD_ID, eurchbToken);
  expect(address).toBeTruthy();

  const balance = await getBalance(eurchbToken.chain as SupportedChain, eurchbToken.address, address!);
  console.log(`[test] Xavier EURchb balance: ${balance.toString()} (${Number(balance) / 1e6} EURchb)`);
  expect(balance).toBeGreaterThan(0n);
});

Deno.test("same token resolves same address consistently", async () => {
  const addr1 = await getAccountAddressForToken(XAVIER_DISCORD_ID, chtToken);
  const addr2 = await getAccountAddressForToken(XAVIER_DISCORD_ID, chtToken);
  expect(addr1).toBe(addr2);
});
