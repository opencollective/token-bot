import { expect } from "@std/expect/expect";
import { stub } from "@std/testing/mock";
import {
  type EtherscanTokenTransfer,
  getLastMonthTransfersSummary,
  getTransfersSummary,
  getYesterdayTransfersSummary,
  type Monitor,
} from "../src/lib/etherscan.ts";

// Mock monitor for testing
const mockMonitor: Monitor = {
  name: "Test Monitor",
  provider: "etherscan",
  chain: "gnosis",
  token: {
    address: "0x7079253c0358eF9Fd87E16488299Ef6e06F403B6",
    name: "Test Token",
    symbol: "TEST",
    decimals: 6,
  },
  frequency: "daily",
  channelId: "123456789",
  address: "0x70e15a0D3239Da96d84c932705644486dd09146D",
};

// Mock token transfer data
const createMockTransfer = (
  timestamp: number,
  value: string,
  to: string,
  from: string,
): EtherscanTokenTransfer => ({
  blockNumber: "123456",
  timeStamp: timestamp.toString(),
  hash: `0x${Math.random().toString(16).slice(2)}` as `0x${string}`,
  nonce: "1",
  blockHash: "0xblock" as `0x${string}`,
  from: from as `0x${string}`,
  contractAddress: mockMonitor.token.address as `0x${string}`,
  to: to as `0x${string}`,
  value,
  tokenName: mockMonitor.token.name,
  tokenSymbol: mockMonitor.token.symbol,
  tokenDecimal: mockMonitor.token.decimals.toString(),
  transactionIndex: "0",
  gas: "21000",
  gasPrice: "1000000000",
  gasUsed: "21000",
  cumulativeGasUsed: "21000",
  input: "0x",
  confirmations: "100",
});

// Helper to create mock fetch response
const createMockFetchResponse = (transfers: EtherscanTokenTransfer[]) => {
  return new Response(
    JSON.stringify({
      status: "1",
      message: "OK",
      result: transfers,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
};

// Mock Etherscan API key
Deno.env.set("ETHEREUM_ETHERSCAN_API_KEY", "test-api-key");

Deno.test({
  name: "getTransfersSummary - should return null if no transactions in range",
  fn: async () => {
    // Mock empty response (no transactions)
    const fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(createMockFetchResponse([])),
    );

    try {
      // Use a date range far in the future where no transactions exist
      const startDate = new Date("2030-01-01");
      const endDate = new Date("2030-01-02");

      const result = await getTransfersSummary(
        mockMonitor,
        startDate,
        endDate,
        "test period",
      );

      expect(result).toBeNull();
    } finally {
      fetchStub.restore();
    }
  },
});

Deno.test({
  name: "getTransfersSummary - should return summary for a specific date range",
  fn: async () => {
    // Use a date range where we expect transactions
    const startDate = new Date("2024-01-01");
    const endDate = new Date("2024-12-31");
    const timestamp = Math.floor(new Date("2024-06-15").getTime() / 1000);

    // Mock response with some transactions
    const mockTransfers = [
      createMockTransfer(timestamp, "1000000", mockMonitor.address, "0xSender"),
      createMockTransfer(timestamp + 100, "500000", "0xRecipient", mockMonitor.address),
    ];

    const fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(createMockFetchResponse(mockTransfers)),
    );

    try {
      const result = await getTransfersSummary(
        mockMonitor,
        startDate,
        endDate,
        "test period",
      );

      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
      expect(result).toContain("Test Monitor");
      expect(result).toContain("test period");
      expect(result).toContain("TEST");
      expect(result).toContain("View");
    } finally {
      fetchStub.restore();
    }
  },
});

Deno.test({
  name: "getTransfersSummary - should format message correctly with date range",
  fn: async () => {
    const startDate = new Date("2024-11-01");
    const endDate = new Date("2024-11-30");
    const timestamp = Math.floor(new Date("2024-11-15").getTime() / 1000);

    // Mock response with transactions in November
    const mockTransfers = [
      createMockTransfer(timestamp, "2000000", mockMonitor.address, "0xSender"),
    ];

    const fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(createMockFetchResponse(mockTransfers)),
    );

    try {
      const result = await getTransfersSummary(
        mockMonitor,
        startDate,
        endDate,
        "November",
      );

      expect(result).not.toBeNull();
      expect(result).toContain("Test Monitor transactions November");
      expect(result).toContain(startDate.toLocaleDateString());
      expect(result).toContain(endDate.toLocaleDateString());
    } finally {
      fetchStub.restore();
    }
  },
});

Deno.test({
  name: "getYesterdayTransfersSummary - should return summary or null",
  fn: async () => {
    // Calculate yesterday's timestamp
    const d = new Date();
    const yesterday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
    const timestamp = Math.floor(yesterday.getTime() / 1000) + 3600; // Add an hour to be in the middle of the day

    // Mock response with transactions from yesterday
    const mockTransfers = [
      createMockTransfer(timestamp, "1500000", mockMonitor.address, "0xSender"),
    ];

    const fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(createMockFetchResponse(mockTransfers)),
    );

    try {
      const result = await getYesterdayTransfersSummary(mockMonitor);

      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
      expect(result).toContain("Test Monitor");
      expect(result).toContain("yesterday");
      expect(result).toContain("TEST");
    } finally {
      fetchStub.restore();
    }
  },
});

Deno.test({
  name: "getLastMonthTransfersSummary - should return summary or null",
  fn: async () => {
    // Calculate last month's timestamp
    const d = new Date();
    const lastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 15);
    const timestamp = Math.floor(lastMonth.getTime() / 1000);

    // Mock response with transactions from last month
    const mockTransfers = [
      createMockTransfer(timestamp, "3000000", mockMonitor.address, "0xSender"),
    ];

    const fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(createMockFetchResponse(mockTransfers)),
    );

    try {
      const result = await getLastMonthTransfersSummary(mockMonitor);

      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
      expect(result).toContain("Test Monitor");
      // Should contain month name (e.g., "in October")
      expect(result).toMatch(/in \w+/);
      expect(result).toContain("TEST");
    } finally {
      fetchStub.restore();
    }
  },
});

Deno.test({
  name: "getLastMonthTransfersSummary - should calculate last month correctly",
  fn: async () => {
    // Test that last month range is calculated correctly
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const timestamp = Math.floor(lastMonth.getTime() / 1000);

    // Mock response with transactions from last month
    const mockTransfers = [
      createMockTransfer(timestamp, "2500000", mockMonitor.address, "0xSender"),
    ];

    const fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(createMockFetchResponse(mockTransfers)),
    );

    try {
      const result = await getLastMonthTransfersSummary(mockMonitor);

      // Verify that monthly reports don't show dates (only month name)
      expect(result).not.toBeNull();
      expect(result).toMatch(/in \w+/); // Should have "in {MonthName}"
      expect(result).not.toMatch(/\(\d{1,2}\/\d{1,2}\/\d{4}/); // Should NOT have date range
    } finally {
      fetchStub.restore();
    }
  },
});

Deno.test({
  name: "getTransfersSummary - should handle multiple transactions correctly",
  fn: async () => {
    // Use a date range that likely has transactions
    const startDate = new Date("2024-06-01");
    const endDate = new Date("2024-06-30");
    const timestamp = Math.floor(new Date("2024-06-15").getTime() / 1000);

    // Mock response with multiple transactions
    const mockTransfers = [
      createMockTransfer(timestamp, "1000000", mockMonitor.address, "0xSender1"),
      createMockTransfer(timestamp + 100, "2000000", mockMonitor.address, "0xSender2"),
      createMockTransfer(timestamp + 200, "500000", "0xRecipient", mockMonitor.address),
    ];

    const fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(createMockFetchResponse(mockTransfers)),
    );

    try {
      const result = await getTransfersSummary(
        mockMonitor,
        startDate,
        endDate,
        "June 2024",
      );

      expect(result).not.toBeNull();
      // Should contain transaction count
      expect(result).toMatch(/\d+ transactions?/);
      // Should contain token amount
      expect(result).toMatch(/\d+(\.\d+)? TEST in/);
      // Should contain view link
      expect(result).toContain("https://txinfo.xyz/gnosis/token/");
      expect(result).toContain(mockMonitor.token.address);
      expect(result).toContain(mockMonitor.address);
    } finally {
      fetchStub.restore();
    }
  },
});

Deno.test({
  name: "getTransfersSummary - should pluralize 'transaction' correctly - single",
  fn: async () => {
    const startDate = new Date("2024-01-01");
    const endDate = new Date("2024-12-31");
    const timestamp = Math.floor(new Date("2024-06-15").getTime() / 1000);

    // Mock response with a single transaction
    const mockTransfers = [
      createMockTransfer(timestamp, "1000000", mockMonitor.address, "0xSender"),
    ];

    const fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(createMockFetchResponse(mockTransfers)),
    );

    try {
      const result = await getTransfersSummary(
        mockMonitor,
        startDate,
        endDate,
        "test",
      );

      expect(result).not.toBeNull();
      // Should have singular "transaction"
      expect(result).toContain("1 transaction");
      expect(result).not.toContain("1 transactions");
    } finally {
      fetchStub.restore();
    }
  },
});

Deno.test({
  name: "getTransfersSummary - should pluralize 'transaction' correctly - multiple",
  fn: async () => {
    const startDate = new Date("2024-01-01");
    const endDate = new Date("2024-12-31");
    const timestamp = Math.floor(new Date("2024-06-15").getTime() / 1000);

    // Mock response with multiple transactions
    const mockTransfers = [
      createMockTransfer(timestamp, "1000000", mockMonitor.address, "0xSender1"),
      createMockTransfer(timestamp + 100, "2000000", mockMonitor.address, "0xSender2"),
    ];

    const fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(createMockFetchResponse(mockTransfers)),
    );

    try {
      const result = await getTransfersSummary(
        mockMonitor,
        startDate,
        endDate,
        "test",
      );

      expect(result).not.toBeNull();
      // Should have plural "transactions"
      expect(result).toContain("2 transactions");
    } finally {
      fetchStub.restore();
    }
  },
});

// Unit tests that don't require API key
Deno.test("Date calculation - yesterday should be correct", () => {
  const d = new Date();
  const expectedStartOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  const expectedEndOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // Verify date calculations are correct
  expect(expectedStartOfDay.getDate()).toBe(
    d.getDate() - 1 || new Date(d.getFullYear(), d.getMonth(), 0).getDate(),
  );
  expect(expectedEndOfDay.getDate()).toBe(d.getDate());
});

Deno.test("Date calculation - last month should be correct", () => {
  const d = new Date();
  const startOfLastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const endOfLastMonth = new Date(d.getFullYear(), d.getMonth(), 1);

  // Verify last month calculations
  expect(startOfLastMonth.getDate()).toBe(1);
  expect(endOfLastMonth.getDate()).toBe(1);
  expect(startOfLastMonth.getMonth()).toBe((d.getMonth() - 1 + 12) % 12);
  expect(endOfLastMonth.getMonth()).toBe(d.getMonth());
});
