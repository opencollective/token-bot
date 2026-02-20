/**
 * Balance check integration test
 *
 * Verifies address resolution and balance fetching for both wallet managers:
 * - CHT (citizenwallet): resolves via Celo CardManager
 * - EURchb (opencollective): resolves via Safe address prediction
 *
 * Requires: network access (RPC), PRIVATE_KEY env var (for OC Safe prediction)
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
  walletManager: "citizenwallet",
};

const eurchbToken: Token = {
  name: "EURchb",
  symbol: "EURchb",
  decimals: 6,
  chain: "gnosis",
  address: "0x5815E61eF72c9E6107b5c5A05FD121F334f7a7f1",
  mintable: false,
  walletManager: "opencollective",
};

Deno.test("resolves Xavier's CHT address (citizenwallet)", async () => {
  const address = await getAccountAddressForToken(XAVIER_DISCORD_ID, chtToken);
  console.log(`[test] Xavier CHT address: ${address}`);
  expect(address).toBeTruthy();
  expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
});

Deno.test("Xavier has positive CHT balance", async () => {
  const address = await getAccountAddressForToken(XAVIER_DISCORD_ID, chtToken);
  expect(address).toBeTruthy();
  const balance = await getBalance(chtToken.chain as SupportedChain, chtToken.address, address!);
  console.log(`[test] CHT balance: ${Number(balance) / 1e6}`);
  expect(balance).toBeGreaterThan(0n);
});

Deno.test({
  name: "resolves Xavier's EURchb address (opencollective)",
  ignore: !Deno.env.get("PRIVATE_KEY"),
  fn: async () => {
    const address = await getAccountAddressForToken(XAVIER_DISCORD_ID, eurchbToken);
    console.log(`[test] Xavier EURchb address: ${address}`);
    expect(address).toBeTruthy();
    expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  },
});

Deno.test({
  name: "Xavier has positive EURchb balance",
  ignore: !Deno.env.get("PRIVATE_KEY"),
  fn: async () => {
    const address = await getAccountAddressForToken(XAVIER_DISCORD_ID, eurchbToken);
    expect(address).toBeTruthy();
    const balance = await getBalance(eurchbToken.chain as SupportedChain, eurchbToken.address, address!);
    console.log(`[test] EURchb balance: ${Number(balance) / 1e6}`);
    expect(balance).toBeGreaterThan(0n);
  },
});

Deno.test({
  name: "CHT and EURchb resolve to different addresses",
  ignore: !Deno.env.get("PRIVATE_KEY"),
  fn: async () => {
    const chtAddr = await getAccountAddressForToken(XAVIER_DISCORD_ID, chtToken);
    const eurchbAddr = await getAccountAddressForToken(XAVIER_DISCORD_ID, eurchbToken);
    console.log(`[test] CHT addr: ${chtAddr}`);
    console.log(`[test] EURchb addr: ${eurchbAddr}`);
    expect(chtAddr).not.toBe(eurchbAddr);
  },
});
