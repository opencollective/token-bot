/**
 * Unified monitor interface that dispatches to the appropriate provider
 * based on the monitor's provider attribute
 */

import {
  getLastMonthTransfersSummary as getEtherscanLastMonth,
  getLastWeekTransfersSummary as getEtherscanLastWeek,
  getYesterdayTransfersSummary as getEtherscanYesterday,
  type Monitor as EtherscanMonitor,
} from "./etherscan.ts";

import {
  getLastMonthTransfersSummary as getStripeLastMonth,
  getLastWeekTransfersSummary as getStripeLastWeek,
  getYesterdayTransfersSummary as getStripeYesterday,
  type StripeMonitor,
} from "./stripe.ts";

import {
  getLastMonthTransfersSummary as getOpenCollectiveLastMonth,
  getLastWeekTransfersSummary as getOpenCollectiveLastWeek,
  getYesterdayTransfersSummary as getOpenCollectiveYesterday,
  type OpenCollectiveMonitor,
} from "./opencollective.ts";

/**
 * Union type for all supported monitor types
 */
export type Monitor = EtherscanMonitor | StripeMonitor | OpenCollectiveMonitor;

/**
 * Get transaction summary for yesterday
 * @param monitor - Monitor configuration (any supported provider)
 * @returns Summary message or null if no transactions
 */
export async function getYesterdayTransfersSummary(
  monitor: Monitor,
): Promise<string | null> {
  switch (monitor.provider) {
    case "etherscan":
      return await getEtherscanYesterday(monitor);
    case "stripe":
      return await getStripeYesterday(monitor);
    case "opencollective":
      return await getOpenCollectiveYesterday(monitor);
    default:
      console.error(
        `Unsupported provider: ${(monitor as { provider: string }).provider}`,
      );
      return null;
  }
}

/**
 * Get transaction summary for the last week
 * @param monitor - Monitor configuration (any supported provider)
 * @returns Summary message or null if no transactions
 */
export async function getLastWeekTransfersSummary(
  monitor: Monitor,
): Promise<string | null> {
  switch (monitor.provider) {
    case "etherscan":
      return await getEtherscanLastWeek(monitor);
    case "stripe":
      return await getStripeLastWeek(monitor);
    case "opencollective":
      return await getOpenCollectiveLastWeek(monitor);
    default:
      console.error(
        `Unsupported provider: ${(monitor as { provider: string }).provider}`,
      );
      return null;
  }
}

/**
 * Get transaction summary for the last month
 * @param monitor - Monitor configuration (any supported provider)
 * @returns Summary message or null if no transactions
 */
export async function getLastMonthTransfersSummary(
  monitor: Monitor,
): Promise<string | null> {
  switch (monitor.provider) {
    case "etherscan":
      return await getEtherscanLastMonth(monitor);
    case "stripe":
      return await getStripeLastMonth(monitor);
    case "opencollective":
      return await getOpenCollectiveLastMonth(monitor);
    default:
      console.error(
        `Unsupported provider: ${(monitor as { provider: string }).provider}`,
      );
      return null;
  }
}
