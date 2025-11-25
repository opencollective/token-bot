import { expect } from "@std/expect/expect";
import { stub } from "@std/testing/mock";
import {
  getLastMonthTransfersSummary,
  getTransfersSummary,
  getYesterdayTransfersSummary,
  getLastWeekTransfersSummary,
  type OpenCollectiveMonitor,
  type OpenCollectiveTransaction,
  OpenCollectiveClient,
} from "../src/lib/opencollective.ts";

// Mock monitor for testing
const mockMonitor: OpenCollectiveMonitor = {
  name: "Test Collective",
  provider: "opencollective",
  collectiveSlug: "test-collective",
  currency: "USD",
  frequency: "daily",
  channelId: "123456789",
};

// Mock transaction data
const createMockTransaction = (
  id: string,
  type: "CREDIT" | "DEBIT",
  value: number,
  currency: string,
  createdAt: Date,
  description?: string,
): OpenCollectiveTransaction => ({
  id,
  type,
  amount: {
    value,
    currency,
  },
  createdAt: createdAt.toISOString(),
  description,
});

Deno.test("OpenCollectiveClient - getTransactions with date range", async () => {
  const startDate = new Date("2024-11-01");
  const endDate = new Date("2024-11-30");

  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      100.50,
      "USD",
      new Date("2024-11-15"),
      "Donation",
    ),
    createMockTransaction(
      "tx_2",
      "CREDIT",
      50.25,
      "USD",
      new Date("2024-11-20"),
      "Contribution",
    ),
  ];

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
                  totalCount: 2,
                  nodes: mockTransactions,
                },
              },
            },
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const client = new OpenCollectiveClient();
    const transactions = await client.getTransactions(
      "test-collective",
      startDate,
      endDate,
    );

    expect(transactions).toHaveLength(2);
    expect(transactions[0].type).toBe("CREDIT");
    expect(transactions[0].amount.value).toBe(100.50);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("OpenCollectiveClient - handles pagination", async () => {
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
              data: {
                account: {
                  transactions: {
                    totalCount: 2,
                    nodes: [
                      createMockTransaction(
                        "tx_1",
                        "CREDIT",
                        100,
                        "USD",
                        new Date("2024-11-15"),
                      ),
                    ],
                  },
                },
              },
            }),
            { status: 200 },
          ),
        );
      } else {
        // Second page
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                account: {
                  transactions: {
                    totalCount: 2,
                    nodes: [
                      createMockTransaction(
                        "tx_2",
                        "DEBIT",
                        50,
                        "USD",
                        new Date("2024-11-20"),
                      ),
                    ],
                  },
                },
              },
            }),
            { status: 200 },
          ),
        );
      }
    },
  );

  try {
    const client = new OpenCollectiveClient();
    const transactions = await client.getTransactions(
      "test-collective",
      startDate,
      endDate,
    );

    expect(transactions).toHaveLength(2);
    expect(callCount).toBe(2);
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getTransfersSummary - yesterday with transactions", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      100.50,
      "USD",
      new Date(yesterday.getTime() + 3600000),
      "Donation",
    ),
    createMockTransaction(
      "tx_2",
      "CREDIT",
      50.25,
      "USD",
      new Date(yesterday.getTime() + 7200000),
      "Contribution",
    ),
    createMockTransaction(
      "tx_3",
      "DEBIT",
      20.00,
      "USD",
      new Date(yesterday.getTime() + 10800000),
      "Expense",
    ),
  ];

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
                  totalCount: 3,
                  nodes: mockTransactions,
                },
              },
            },
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
    expect(summary).toContain("Test Collective transactions yesterday");
    expect(summary).toContain("3 transactions");
    // Total in: $100.50 + $50.25 = $150.75
    expect(summary).toContain("150.75 USD in");
    // Total out: $20.00
    expect(summary).toContain("20.00 USD out");
    expect(summary).toContain(
      "https://opencollective.com/test-collective/transactions",
    );
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getTransfersSummary - last week with date range", async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      1000.00,
      "USD",
      new Date(weekAgo.getTime() + 86400000),
      "Large donation",
    ),
  ];

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
                  totalCount: 1,
                  nodes: mockTransactions,
                },
              },
            },
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
    expect(summary).toContain("Test Collective transactions last week");
    // Should show date range for week
    expect(summary).toMatch(/\(\d{1,2}\/\d{1,2}\/\d{4} - \d{1,2}\/\d{1,2}\/\d{4}\)/);
    expect(summary).toContain("1 transaction");
    expect(summary).toContain("1000.00 USD in");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getTransfersSummary - last month without date range", async () => {
  const today = new Date();
  const startOfLastMonth = new Date(
    today.getFullYear(),
    today.getMonth() - 1,
    1,
  );
  const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      2500.00,
      "USD",
      new Date(startOfLastMonth.getTime() + 86400000),
    ),
    createMockTransaction(
      "tx_2",
      "CREDIT",
      1500.00,
      "USD",
      new Date(startOfLastMonth.getTime() + 172800000),
    ),
    createMockTransaction(
      "tx_3",
      "DEBIT",
      500.00,
      "USD",
      new Date(startOfLastMonth.getTime() + 259200000),
    ),
  ];

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
                  totalCount: 3,
                  nodes: mockTransactions,
                },
              },
            },
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
    expect(summary).toContain(`Test Collective transactions in ${monthName}`);
    // Should NOT show date range for monthly
    expect(summary).not.toMatch(/\(\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(summary).toContain("3 transactions");
    expect(summary).toContain("4000.00 USD in");
    expect(summary).toContain("500.00 USD out");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getTransfersSummary - no transactions returns null", async () => {
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
    const summary = await getTransfersSummary(
      mockMonitor,
      yesterday,
      today,
      "yesterday",
    );

    expect(summary).toBeNull();
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getTransfersSummary - only incoming transactions", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = new Date();

  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      100.00,
      "USD",
      new Date(yesterday.getTime() + 3600000),
    ),
  ];

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
                  totalCount: 1,
                  nodes: mockTransactions,
                },
              },
            },
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
  }
});

Deno.test("getTransfersSummary - currency auto-detection", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = new Date();

  // Monitor without currency specified
  const monitorWithoutCurrency: OpenCollectiveMonitor = {
    name: "Test Collective EUR",
    provider: "opencollective",
    collectiveSlug: "test-collective-eur",
    frequency: "daily",
    channelId: "123456789",
  };

  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      100.00,
      "EUR",
      new Date(yesterday.getTime() + 3600000),
    ),
  ];

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
                  totalCount: 1,
                  nodes: mockTransactions,
                },
              },
            },
          }),
          { status: 200 },
        ),
      ),
  );

  try {
    const summary = await getTransfersSummary(
      monitorWithoutCurrency,
      yesterday,
      today,
      "yesterday",
    );

    expect(summary).toBeTruthy();
    expect(summary).toContain("100.00 EUR in");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getTransfersSummary - decimal formatting", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = new Date();

  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      123.456, // Should round to 123.46
      "USD",
      new Date(yesterday.getTime() + 3600000),
    ),
    createMockTransaction(
      "tx_2",
      "DEBIT",
      6.789, // Should round to 6.79
      "USD",
      new Date(yesterday.getTime() + 7200000),
    ),
  ];

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
                  totalCount: 2,
                  nodes: mockTransactions,
                },
              },
            },
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
    expect(summary).toContain("123.46 USD in");
    expect(summary).toContain("6.79 USD out");
  } finally {
    fetchStub.restore();
  }
});

Deno.test("getYesterdayTransfersSummary - wrapper function", async () => {
  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      100,
      "USD",
      new Date(Date.now() - 86400000),
    ),
  ];

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
                  totalCount: 1,
                  nodes: mockTransactions,
                },
              },
            },
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
  }
});

Deno.test("getLastWeekTransfersSummary - wrapper function", async () => {
  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      100,
      "USD",
      new Date(Date.now() - 86400000 * 3),
    ),
  ];

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
                  totalCount: 1,
                  nodes: mockTransactions,
                },
              },
            },
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
  }
});

Deno.test("getLastMonthTransfersSummary - wrapper function", async () => {
  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "CREDIT",
      100,
      "USD",
      new Date(Date.now() - 86400000 * 15),
    ),
  ];

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
                  totalCount: 1,
                  nodes: mockTransactions,
                },
              },
            },
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
  }
});

Deno.test("getTransfersSummary - only DEBIT transactions", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = new Date();

  const mockTransactions: OpenCollectiveTransaction[] = [
    createMockTransaction(
      "tx_1",
      "DEBIT",
      50.00,
      "USD",
      new Date(yesterday.getTime() + 3600000),
    ),
    createMockTransaction(
      "tx_2",
      "DEBIT",
      30.00,
      "USD",
      new Date(yesterday.getTime() + 7200000),
    ),
  ];

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
                  totalCount: 2,
                  nodes: mockTransactions,
                },
              },
            },
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
    expect(summary).toContain("2 transactions");
    expect(summary).toContain("0.00 USD in");
    expect(summary).toContain("80.00 USD out");
  } finally {
    fetchStub.restore();
  }
});

