/**
 * OpenCollective GraphQL API v2 client for monitoring transaction summaries
 */

export type OpenCollectiveMonitor = {
  name: string;
  provider: "opencollective";
  collectiveSlug: string;
  currency?: string; // Will be detected from transactions if not provided
  frequency: "daily";
  channelId: string;
  // Optional API key from OPENCOLLECTIVE_API_KEY env variable
};

export type OpenCollectiveTransaction = {
  id: string;
  type: "CREDIT" | "DEBIT";
  amount: {
    value: number;
    currency: string;
  };
  createdAt: string;
  description?: string;
};

export type OpenCollectiveTransactionsResponse = {
  data: {
    account: {
      transactions: {
        nodes: OpenCollectiveTransaction[];
        totalCount: number;
      };
    };
  };
};

/**
 * Client for interacting with OpenCollective GraphQL API v2
 */
export class OpenCollectiveClient {
  private apiUrl = "https://api.opencollective.com/graphql/v2";
  private apiKey?: string;
  private rateLimitDelay = 100; // 100ms between requests

  constructor() {
    this.apiKey = Deno.env.get("OPENCOLLECTIVE_API_KEY");
  }

  /**
   * Make a GraphQL query
   */
  private async query<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    await new Promise((resolve) => setTimeout(resolve, this.rateLimitDelay));

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Api-Key"] = this.apiKey;
    }

    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        variables,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `OpenCollective API request failed: ${response.statusText} - ${error}`,
      );
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(
        `OpenCollective GraphQL error: ${JSON.stringify(result.errors)}`,
      );
    }

    return result;
  }

  /**
   * Get transactions for a collective within a date range
   * @param collectiveSlug - The slug of the collective
   * @param startDate - Start date for the range
   * @param endDate - End date for the range
   * @returns Array of transactions
   */
  async getTransactions(
    collectiveSlug: string,
    startDate: Date,
    endDate: Date,
  ): Promise<OpenCollectiveTransaction[]> {
    const query = `
      query GetTransactions($slug: String!, $dateFrom: DateTime, $dateTo: DateTime, $limit: Int!, $offset: Int!) {
        account(slug: $slug) {
          transactions(dateFrom: $dateFrom, dateTo: $dateTo, limit: $limit, offset: $offset) {
            totalCount
            nodes {
              id
              type
              amount {
                value
                currency
              }
              createdAt
              description
            }
          }
        }
      }
    `;

    const allTransactions: OpenCollectiveTransaction[] = [];
    const limit = 100;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const variables = {
        slug: collectiveSlug,
        dateFrom: startDate.toISOString(),
        dateTo: endDate.toISOString(),
        limit,
        offset,
      };

      const response = await this.query<OpenCollectiveTransactionsResponse>(query, variables);

      const transactions = response.data.account.transactions.nodes;
      allTransactions.push(...transactions);

      // Check if there are more transactions
      hasMore = allTransactions.length < response.data.account.transactions.totalCount;
      offset += limit;
    }

    return allTransactions;
  }
}

function pluralize(word: string, count: number) {
  return count === 1 ? word : `${word}s`;
}

function formatDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}`;
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Generic function to get transaction summary for a specific time range
 * @param monitor - Monitor configuration
 * @param startDate - Start date for the range
 * @param endDate - End date for the range
 * @param periodLabel - Label to use in the message (e.g., "yesterday", "last month")
 * @returns Summary message or null if no transactions
 */
export async function getTransfersSummary(
  monitor: OpenCollectiveMonitor,
  startDate: Date,
  endDate: Date,
  periodLabel: string,
) {
  const client = new OpenCollectiveClient();

  const transactions = await client.getTransactions(
    monitor.collectiveSlug,
    startDate,
    endDate,
  );

  if (transactions.length === 0) {
    console.log(
      `No transactions found for ${monitor.name} ${periodLabel}`,
    );
    return null;
  }

  // Calculate total in (CREDIT) and total out (DEBIT)
  let totalAmountIn = 0;
  let totalAmountOut = 0;
  let currency = monitor.currency;

  for (const tx of transactions) {
    // Detect currency from first transaction if not provided
    if (!currency) {
      currency = tx.amount.currency;
    }

    // Amount value is already in the base unit (not cents)
    const amount = Math.abs(tx.amount.value);

    if (tx.type === "CREDIT") {
      totalAmountIn += amount;
    } else if (tx.type === "DEBIT") {
      totalAmountOut += amount;
    }
  }

  if (totalAmountIn === 0 && totalAmountOut === 0) {
    console.log(
      `No significant transactions found for ${monitor.name} ${periodLabel}`,
    );
    return null;
  }

  // Default to USD if no currency detected
  if (!currency) {
    currency = "USD";
  }

  // Format message based on period type
  const isMoreThanOneDay = (endDate.getTime() - startDate.getTime()) >
    86400000;
  const isMonthly = periodLabel.startsWith("in ");
  const isWeekly = periodLabel === "last week";
  const isDaily = periodLabel === "yesterday";

  let message = "";

  const txLink = `https://opencollective.com/${monitor.collectiveSlug}/transactions`;

  if (isWeekly) {
    // Weekly report format
    const weekNum = getWeekNumber(startDate);
    message = `${monitor.name} weekly report:\n`;
    message += `- 🗓️ Week ${weekNum} (${formatDate(startDate)}-${
      formatDate(endDate)
    }): [${transactions.length} ${pluralize("transaction", transactions.length)}](<${txLink}>)\n`;
    message += `- ↘️ ${totalAmountIn.toFixed(2)} ${currency.toUpperCase()} (credit)\n`;
    message += `- ↗️ ${totalAmountOut.toFixed(2)} ${currency.toUpperCase()} (debit)`;
  } else if (isMonthly) {
    // Monthly report format
    message = `${monitor.name} monthly report:\n`;
    message += `- 📅 ${periodLabel.replace("in ", "")}: [${transactions.length} ${
      pluralize("transaction", transactions.length)
    }](<${txLink}>)\n`;
    message += `- ↘️ ${totalAmountIn.toFixed(2)} ${currency.toUpperCase()} (credit)\n`;
    message += `- ↗️ ${totalAmountOut.toFixed(2)} ${currency.toUpperCase()} (debit)`;
  } else if (isDaily) {
    // Daily report format
    message = `${monitor.name} daily report:\n`;
    message += `- 📆 ${formatDate(startDate)}: [${transactions.length} ${
      pluralize("transaction", transactions.length)
    }](<${txLink}>)\n`;
    message += `- ↘️ ${totalAmountIn.toFixed(2)} ${currency.toUpperCase()} (credit)\n`;
    message += `- ↗️ ${totalAmountOut.toFixed(2)} ${currency.toUpperCase()} (debit)`;
  } else {
    // Fallback to old format for custom periods
    const dateDisplay = isMonthly
      ? ""
      : ` (${startDate.toLocaleDateString()}${
        isMoreThanOneDay ? ` - ${endDate.toLocaleDateString()}` : ""
      })`;
    message = `${monitor.name} transactions ${periodLabel}${dateDisplay}: ${transactions.length} ${
      pluralize("transaction", transactions.length)
    } for a total of ${totalAmountIn.toFixed(2)} ${currency.toUpperCase()} in`;
    if (totalAmountOut > 0) {
      message += ` and ${totalAmountOut.toFixed(2)} ${currency.toUpperCase()} out`;
    }
    message += `\n\n[View transactions](<${txLink}>)`;
  }

  return message;
}

/**
 * Get transaction summary for yesterday
 * @param monitor - Monitor configuration
 * @returns Summary message or null if no transactions
 */
export function getYesterdayTransfersSummary(monitor: OpenCollectiveMonitor) {
  const d = new Date(Deno.env.get("TODAY") || new Date());
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  return getTransfersSummary(monitor, startOfDay, endOfDay, "yesterday");
}

/**
 * Get transaction summary for the last month
 * @param monitor - Monitor configuration
 * @returns Summary message or null if no transactions
 */
export function getLastMonthTransfersSummary(monitor: OpenCollectiveMonitor) {
  const d = new Date(Deno.env.get("TODAY") || new Date());
  // Get first day of last month
  const startOfLastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  // Get first day of current month (which is end of last month)
  const endOfLastMonth = new Date(d.getFullYear(), d.getMonth(), 1);

  // Get the month name (e.g., "October")
  const monthName = startOfLastMonth.toLocaleString("en-US", { month: "long" });

  return getTransfersSummary(
    monitor,
    startOfLastMonth,
    endOfLastMonth,
    `in ${monthName}`,
  );
}

/**
 * Get transaction summary for the last week
 * @param monitor - Monitor configuration
 * @returns Summary message or null if no transactions
 */
export function getLastWeekTransfersSummary(monitor: OpenCollectiveMonitor) {
  const d = new Date(Deno.env.get("TODAY") || new Date());
  const startOfWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
  const endOfWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  return getTransfersSummary(monitor, startOfWeek, endOfWeek, "last week");
}
