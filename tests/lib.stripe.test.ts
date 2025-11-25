import { expect } from "@std/expect/expect";
import { stub } from "@std/testing/mock";
import {
  getLastMonthTransfersSummary,
  getTransfersSummary,
  getYesterdayTransfersSummary,
  getLastWeekTransfersSummary,
  type StripeBalanceTransaction,
  type StripeMonitor,
  StripeClient,
} from "../src/lib/stripe.ts";

// Mock monitor for testing
const mockMonitor: StripeMonitor = {
  name: "Test Stripe Account",
  provider: "stripe",
  currency: "USD",
  frequency: "daily",
  channelId: "123456789",
};

// Mock balance transaction data
const createMockTransaction = (
  id: string,
  amount: number, // in cents
  fee: number, // in cents
  created: number,
  type: string,
): StripeBalanceTransaction => ({
  id,
  object: "balance_transaction",
  amount,
  available_on: created,
  created,
  currency: "usd",
  description: `Test ${type} transaction`,
  fee,
  net: amount - fee,
  status: "available",
  type,
});

Deno.test("StripeClient - getBalanceTransactions with date range", async () => {
  // Mock environment variable
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const startDate = new Date("2024-11-01");
  const endDate = new Date("2024-11-30");

  const mockTransactions: StripeBalanceTransaction[] = [
    createMockTransaction(
      "txn_1",
      10000, // $100.00
      290, // $2.90 fee
      Math.floor(new Date("2024-11-15").getTime() / 1000),
      "charge",
    ),
    createMockTransaction(
      "txn_2",
      5000, // $50.00
      145, // $1.45 fee
      Math.floor(new Date("2024-11-20").getTime() / 1000),
      "charge",
    ),
  ];

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: mockTransactions,
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const client = new StripeClient();
    const transactions = await client.getBalanceTransactions(
      startDate,
      endDate,
    );

    expect(transactions).toHaveLength(2);
    expect(transactions[0].amount).toBe(10000);
    expect(transactions[1].amount).toBe(5000);
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("StripeClient - handles pagination", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const startDate = new Date("2024-11-01");
  const endDate = new Date("2024-11-30");

  let callCount = 0;
  const fetchStub = stub(
    globalThis,
    "fetch",
    () => {
      callCount++;
      if (callCount === 1) {
        // First page
        return Promise.resolve(
          new Response(
            JSON.stringify({
              object: "list",
              data: [
                createMockTransaction(
                  "txn_1",
                  10000,
                  290,
                  Math.floor(new Date("2024-11-15").getTime() / 1000),
                  "charge",
                ),
              ],
              has_more: true,
              url: "/v1/balance_transactions",
            }),
            { status: 200 },
          ),
        );
      } else {
        // Second page
        return Promise.resolve(
          new Response(
            JSON.stringify({
              object: "list",
              data: [
                createMockTransaction(
                  "txn_2",
                  5000,
                  145,
                  Math.floor(new Date("2024-11-20").getTime() / 1000),
                  "charge",
                ),
              ],
              has_more: false,
              url: "/v1/balance_transactions",
            }),
            { status: 200 },
          ),
        );
      }
    },
  );

  try {
    const client = new StripeClient();
    const transactions = await client.getBalanceTransactions(
      startDate,
      endDate,
    );

    expect(transactions).toHaveLength(2);
    expect(callCount).toBe(2);
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("getTransfersSummary - yesterday with transactions", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const mockTransactions: StripeBalanceTransaction[] = [
    createMockTransaction(
      "txn_1",
      10050, // $100.50
      291, // $2.91 fee
      Math.floor(yesterday.getTime() / 1000) + 3600,
      "charge",
    ),
    createMockTransaction(
      "txn_2",
      5025, // $50.25
      146, // $1.46 fee
      Math.floor(yesterday.getTime() / 1000) + 7200,
      "charge",
    ),
    createMockTransaction(
      "txn_3",
      -2000, // -$20.00 (refund)
      0,
      Math.floor(yesterday.getTime() / 1000) + 10800,
      "refund",
    ),
  ];

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: mockTransactions,
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const summary = await getTransfersSummary(
      mockMonitor,
      yesterday,
      today,
      "yesterday",
    );

    expect(summary).toBeTruthy();
    expect(summary).toContain("Test Stripe Account transactions yesterday");
    expect(summary).toContain("3 transactions");
    // Total in: $100.50 + $50.25 = $150.75
    expect(summary).toContain("150.75 USD in");
    // Total out: $20.00 (refund) + $2.91 + $1.46 (fees) = $24.37
    expect(summary).toContain("24.37 USD out");
    expect(summary).toContain("https://dashboard.stripe.com/balance/overview");
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("getTransfersSummary - last week with date range", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const mockTransactions: StripeBalanceTransaction[] = [
    createMockTransaction(
      "txn_1",
      100000, // $1,000.00
      2900,
      Math.floor(weekAgo.getTime() / 1000) + 86400,
      "charge",
    ),
  ];

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: mockTransactions,
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const summary = await getTransfersSummary(
      mockMonitor,
      weekAgo,
      today,
      "last week",
    );

    expect(summary).toBeTruthy();
    expect(summary).toContain("Test Stripe Account transactions last week");
    // Should show date range for week
    expect(summary).toMatch(/\(\d{1,2}\/\d{1,2}\/\d{4} - \d{1,2}\/\d{1,2}\/\d{4}\)/);
    expect(summary).toContain("1 transaction");
    expect(summary).toContain("1000.00 USD in");
    expect(summary).toContain("29.00 USD out");
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("getTransfersSummary - last month without date range", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const today = new Date();
  const startOfLastMonth = new Date(
    today.getFullYear(),
    today.getMonth() - 1,
    1,
  );
  const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const mockTransactions: StripeBalanceTransaction[] = [
    createMockTransaction(
      "txn_1",
      250000, // $2,500.00
      7250,
      Math.floor(startOfLastMonth.getTime() / 1000) + 86400,
      "charge",
    ),
    createMockTransaction(
      "txn_2",
      150000, // $1,500.00
      4350,
      Math.floor(startOfLastMonth.getTime() / 1000) + 172800,
      "charge",
    ),
  ];

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: mockTransactions,
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const monthName = startOfLastMonth.toLocaleString("en-US", {
      month: "long",
    });
    const summary = await getTransfersSummary(
      mockMonitor,
      startOfLastMonth,
      endOfLastMonth,
      `in ${monthName}`,
    );

    expect(summary).toBeTruthy();
    expect(summary).toContain(`Test Stripe Account transactions in ${monthName}`);
    // Should NOT show date range for monthly
    expect(summary).not.toMatch(/\(\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(summary).toContain("2 transactions");
    expect(summary).toContain("4000.00 USD in");
    expect(summary).toContain("116.00 USD out");
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("getTransfersSummary - no transactions returns null", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = new Date();

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
    const summary = await getTransfersSummary(
      mockMonitor,
      yesterday,
      today,
      "yesterday",
    );

    expect(summary).toBeNull();
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("getTransfersSummary - only incoming transactions", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = new Date();

  const mockTransactions: StripeBalanceTransaction[] = [
    createMockTransaction(
      "txn_1",
      10000, // $100.00
      0, // No fees
      Math.floor(yesterday.getTime() / 1000) + 3600,
      "charge",
    ),
  ];

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: mockTransactions,
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const summary = await getTransfersSummary(
      mockMonitor,
      yesterday,
      today,
      "yesterday",
    );

    expect(summary).toBeTruthy();
    expect(summary).toContain("100.00 USD in");
    expect(summary).not.toContain("USD out");
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("getTransfersSummary - decimal formatting", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = new Date();

  const mockTransactions: StripeBalanceTransaction[] = [
    createMockTransaction(
      "txn_1",
      12345, // $123.45
      678, // $6.78
      Math.floor(yesterday.getTime() / 1000) + 3600,
      "charge",
    ),
  ];

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: mockTransactions,
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const summary = await getTransfersSummary(
      mockMonitor,
      yesterday,
      today,
      "yesterday",
    );

    expect(summary).toBeTruthy();
    // Should have exactly 2 decimal places
    expect(summary).toContain("123.45 USD in");
    expect(summary).toContain("6.78 USD out");
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("getYesterdayTransfersSummary - wrapper function", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const mockTransactions: StripeBalanceTransaction[] = [
    createMockTransaction(
      "txn_1",
      10000,
      290,
      Math.floor(Date.now() / 1000) - 86400,
      "charge",
    ),
  ];

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: mockTransactions,
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const summary = await getYesterdayTransfersSummary(mockMonitor);
    expect(summary).toBeTruthy();
    expect(summary).toContain("yesterday");
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("getLastWeekTransfersSummary - wrapper function", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const mockTransactions: StripeBalanceTransaction[] = [
    createMockTransaction(
      "txn_1",
      10000,
      290,
      Math.floor(Date.now() / 1000) - 86400 * 3,
      "charge",
    ),
  ];

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: mockTransactions,
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const summary = await getLastWeekTransfersSummary(mockMonitor);
    expect(summary).toBeTruthy();
    expect(summary).toContain("last week");
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

Deno.test("getLastMonthTransfersSummary - wrapper function", async () => {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_mock_key");

  const mockTransactions: StripeBalanceTransaction[] = [
    createMockTransaction(
      "txn_1",
      10000,
      290,
      Math.floor(Date.now() / 1000) - 86400 * 15,
      "charge",
    ),
  ];

  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            data: mockTransactions,
            has_more: false,
            url: "/v1/balance_transactions",
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const summary = await getLastMonthTransfersSummary(mockMonitor);
    expect(summary).toBeTruthy();
    expect(summary).toMatch(/in \w+/); // "in October", "in November", etc.
  } finally {
    fetchStub.restore();
    Deno.env.delete("STRIPE_SECRET_KEY");
  }
});

