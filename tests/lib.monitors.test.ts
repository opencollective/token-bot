import { expect } from "@std/expect/expect";
import { stub } from "@std/testing/mock";
import {
  getYesterdayTransfersSummary,
  getLastWeekTransfersSummary,
  getLastMonthTransfersSummary,
  type Monitor,
} from "../src/lib/monitors.ts";

Deno.test("monitors - dispatches to etherscan provider", async () => {
  Deno.env.set("ETHEREUM_ETHERSCAN_API_KEY", "test_key");

  const etherscanMonitor: Monitor = {
    name: "Test Etherscan",
    provider: "etherscan",
    chain: "gnosis",
    token: {
      address: "0x123",
      name: "Test",
      symbol: "TEST",
      decimals: 6,
    },
    frequency: "daily",
    channelId: "123",
    address: "0x456",
  };

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: "1",
            message: "OK",
            result: [],
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const result = await getYesterdayTransfersSummary(etherscanMonitor);
    expect(result).toBeNull(); // No transactions
  } finally {
    fetchStub.restore();
    Deno.env.delete("ETHEREUM_ETHERSCAN_API_KEY");
  }
});

Deno.test("monitors - dispatches to stripe provider", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_123");

  const stripeMonitor: Monitor = {
    name: "Test Stripe",
    provider: "stripe",
    currency: "USD",
    frequency: "daily",
    channelId: "123",
  };

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: [],
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const result = await getYesterdayTransfersSummary(stripeMonitor);
    expect(result).toBeNull(); // No transactions
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("monitors - dispatches to opencollective provider", async () => {
  const ocMonitor: Monitor = {
    name: "Test OC",
    provider: "opencollective",
    collectiveSlug: "test",
    currency: "USD",
    frequency: "daily",
    channelId: "123",
  };

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              account: {
                transactions: {
                  totalCount: 0,
                  nodes: [],
                },
              },
            },
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const result = await getYesterdayTransfersSummary(ocMonitor);
    expect(result).toBeNull(); // No transactions
  } finally {
    fetchStub.restore();
  }
});

Deno.test("monitors - handles unsupported provider gracefully", async () => {
  const badMonitor = {
    name: "Bad Monitor",
    provider: "unsupported",
    frequency: "daily",
    channelId: "123",
  } as unknown as Monitor;

  const result = await getYesterdayTransfersSummary(badMonitor);
  expect(result).toBeNull();
});





