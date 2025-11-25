/**
 * Stripe API client for monitoring transaction summaries
 */

export type StripeMonitor = {
  name: string;
  provider: "stripe";
  currency: string; // USD, EUR, etc.
  frequency: "daily";
  channelId: string;
  // Secret key comes from STRIPE_SECRET_KEY env variable
};

export type StripeBalanceTransaction = {
  id: string;
  object: string;
  amount: number; // Amount in cents
  available_on: number;
  created: number;
  currency: string;
  description: string | null;
  fee: number;
  net: number;
  status: string;
  type: string; // charge, refund, adjustment, etc.
};

export type StripeListResponse<T> = {
  object: "list";
  data: T[];
  has_more: boolean;
  url: string;
};

/**
 * Client for interacting with Stripe API
 */
export class StripeClient {
  private apiKey: string;
  private apiUrl = "https://api.stripe.com/v1";
  private rateLimitDelay = 100; // 100ms between requests

  constructor() {
    const apiKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!apiKey) {
      throw new Error("STRIPE_SECRET_KEY environment variable is required");
    }
    this.apiKey = apiKey;
  }

  /**
   * Make a rate-limited API request
   */
  private async request<T>(
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.apiUrl}${endpoint}`);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, this.rateLimitDelay));

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Stripe API request failed: ${response.statusText} - ${error}`);
    }

    return await response.json();
  }

  /**
   * Get balance transactions within a date range
   * @param startDate - Start date for the range
   * @param endDate - End date for the range
   * @returns Array of balance transactions
   */
  async getBalanceTransactions(
    startDate: Date,
    endDate: Date,
  ): Promise<StripeBalanceTransaction[]> {
    const startTimestamp = Math.floor(startDate.getTime() / 1000);
    const endTimestamp = Math.floor(endDate.getTime() / 1000);

    const allTransactions: StripeBalanceTransaction[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
      const params: Record<string, string> = {
        limit: "100",
        "created[gte]": startTimestamp.toString(),
        "created[lte]": endTimestamp.toString(),
      };

      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      const response = await this.request<
        StripeListResponse<StripeBalanceTransaction>
      >(
        "/balance_transactions",
        params,
      );

      allTransactions.push(...response.data);
      hasMore = response.has_more;

      if (hasMore && response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id;
      }
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
  monitor: StripeMonitor,
  startDate: Date,
  endDate: Date,
  periodLabel: string,
) {
  const stripe = new StripeClient();

  const transactions = await stripe.getBalanceTransactions(startDate, endDate);

  if (transactions.length === 0) {
    console.log(`No transactions found for ${monitor.name} ${periodLabel}`);
    return null;
  }

  // Calculate total in (positive amounts: charges, etc.)
  // and total out (negative amounts: refunds, fees, etc.)
  let totalAmountIn = 0;
  let totalAmountOut = 0;

  for (const tx of transactions) {
    // Amount is in cents, convert to dollars/euros
    const amount = tx.amount / 100;

    if (amount > 0) {
      totalAmountIn += amount;
    } else if (amount < 0) {
      totalAmountOut += Math.abs(amount);
    }

    // Add fees to out (fees are always positive in the fee field)
    if (tx.fee > 0) {
      totalAmountOut += tx.fee / 100;
    }
  }

  if (totalAmountIn === 0 && totalAmountOut === 0) {
    console.log(`No significant transactions found for ${monitor.name} ${periodLabel}`);
    return null;
  }

  // Format message based on period type
  const isMoreThanOneDay = (endDate.getTime() - startDate.getTime()) > 86400000;
  const isMonthly = periodLabel.startsWith("in ");
  const isWeekly = periodLabel === "last week";
  const isDaily = periodLabel === "yesterday";

  let message = "";

  const txLink = "https://dashboard.stripe.com/balance/overview";

  if (isWeekly) {
    // Weekly report format
    const weekNum = getWeekNumber(startDate);
    message = `${monitor.name} weekly report:\n`;
    message += `- 🗓️ Week ${weekNum} (${formatDate(startDate)}-${
      formatDate(endDate)
    }): [${transactions.length} ${pluralize("transaction", transactions.length)}](<${txLink}>)\n`;
    message += `- ↘️ ${totalAmountIn.toFixed(2)} ${monitor.currency.toUpperCase()} (credit)\n`;
    message += `- ↗️ ${totalAmountOut.toFixed(2)} ${monitor.currency.toUpperCase()} (debit)`;
  } else if (isMonthly) {
    // Monthly report format
    message = `${monitor.name} monthly report:\n`;
    message += `- 📅 ${periodLabel.replace("in ", "")}: [${transactions.length} ${
      pluralize("transaction", transactions.length)
    }](<${txLink}>)\n`;
    message += `- ↘️ ${totalAmountIn.toFixed(2)} ${monitor.currency.toUpperCase()} (credit)\n`;
    message += `- ↗️ ${totalAmountOut.toFixed(2)} ${monitor.currency.toUpperCase()} (debit)`;
  } else if (isDaily) {
    // Daily report format
    message = `${monitor.name} daily report:\n`;
    message += `- 📆 ${formatDate(startDate)}: [${transactions.length} ${
      pluralize("transaction", transactions.length)
    }](<${txLink}>)\n`;
    message += `- ↘️ ${totalAmountIn.toFixed(2)} ${monitor.currency.toUpperCase()} (credit)\n`;
    message += `- ↗️ ${totalAmountOut.toFixed(2)} ${monitor.currency.toUpperCase()} (debit)`;
  } else {
    // Fallback to old format for custom periods
    const dateDisplay = isMonthly
      ? ""
      : ` (${startDate.toLocaleDateString()}${
        isMoreThanOneDay ? ` - ${endDate.toLocaleDateString()}` : ""
      })`;
    message = `${monitor.name} transactions ${periodLabel}${dateDisplay}: ${transactions.length} ${
      pluralize("transaction", transactions.length)
    } for a total of ${totalAmountIn.toFixed(2)} ${monitor.currency.toUpperCase()} in`;
    if (totalAmountOut > 0) {
      message += ` and ${totalAmountOut.toFixed(2)} ${monitor.currency.toUpperCase()} out`;
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
export function getYesterdayTransfersSummary(monitor: StripeMonitor) {
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
export function getLastMonthTransfersSummary(monitor: StripeMonitor) {
  const d = new Date(Deno.env.get("TODAY") || new Date());
  // Get first day of last month
  const startOfLastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  // Get first day of current month (which is end of last month)
  const endOfLastMonth = new Date(d.getFullYear(), d.getMonth(), 1);

  // Get the month name (e.g., "October")
  const monthName = startOfLastMonth.toLocaleString("en-US", { month: "long" });

  return getTransfersSummary(monitor, startOfLastMonth, endOfLastMonth, `in ${monthName}`);
}

/**
 * Get transaction summary for the last week
 * @param monitor - Monitor configuration
 * @returns Summary message or null if no transactions
 */
export function getLastWeekTransfersSummary(monitor: StripeMonitor) {
  const d = new Date(Deno.env.get("TODAY") || new Date());
  const startOfWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
  const endOfWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  return getTransfersSummary(monitor, startOfWeek, endOfWeek, "last week");
}
