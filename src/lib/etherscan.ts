import type { Address, Hash } from "viem";

export type EtherscanTransaction = {
  blockNumber: string;
  timeStamp: string;
  hash: Hash;
  nonce: string;
  blockHash: Hash;
  transactionIndex: string;
  from: Address;
  to: Address;
  value: string;
  gas: string;
  gasPrice: string;
  isError: string;
  txreceipt_status: string;
  input: string;
  contractAddress: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  confirmations: string;
  methodId: string;
  functionName: string;
};

export type EtherscanTokenTransfer = {
  blockNumber: string;
  timeStamp: string;
  hash: Hash;
  nonce: string;
  blockHash: Hash;
  from: Address;
  contractAddress: Address;
  to: Address;
  value: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
  transactionIndex: string;
  gas: string;
  gasPrice: string;
  gasUsed: string;
  cumulativeGasUsed: string;
  input: string;
  confirmations: string;
};

export type EtherscanConfig = {
  apiUrl: string;
  apiKey?: string;
};

/**
 * Client for interacting with Etherscan-compatible APIs (Etherscan, GnosisScan, etc.)
 */
export class EtherscanClient {
  private apiUrl: string;
  private apiKey?: string;
  private chainId: number;
  private rateLimitDelay: number = 200; // 200ms between requests (5 req/sec)

  constructor(chainId: number) {
    this.apiUrl = "https://api.etherscan.io/v2/api";
    this.apiKey = Deno.env.get("ETHEREUM_ETHERSCAN_API_KEY");
    this.chainId = chainId;

    if (!this.apiKey) {
      throw new Error("Etherscan API key is required");
    }
  }

  /**
   * Make a rate-limited API request
   */
  private async request<T>(params: Record<string, string>): Promise<T> {
    const url = new URL(this.apiUrl);

    // Add API key if available
    if (this.apiKey) {
      params.apikey = this.apiKey;
    }

    params.chainid = this.chainId.toString();

    // Add all parameters to URL
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, this.rateLimitDelay));

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Etherscan API request failed: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.status === "0" && data.message !== "No transactions found") {
      throw new Error(`Etherscan API error: ${data.message || data.result}`);
    }

    return data.result;
  }

  /**
   * Get normal transactions for an address
   * @param address - The address to get transactions for
   * @param startBlock - Starting block number (optional)
   * @param endBlock - Ending block number (optional)
   * @param page - Page number for pagination (optional)
   * @param offset - Number of transactions per page (optional, max 10000)
   */
  async getTransactions(
    address: Address,
    startBlock?: number,
    endBlock?: number,
    page: number = 1,
    offset: number = 10000,
  ): Promise<EtherscanTransaction[]> {
    const params: Record<string, string> = {
      module: "account",
      action: "txlist",
      address,
      sort: "desc",
      page: page.toString(),
      offset: offset.toString(),
    };

    if (startBlock !== undefined) {
      params.startblock = startBlock.toString();
    }
    if (endBlock !== undefined) {
      params.endblock = endBlock.toString();
    }

    try {
      const result = await this.request<EtherscanTransaction[]>(params);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      // If no transactions found, return empty array
      if (
        error instanceof Error &&
        error.message.includes("No transactions found")
      ) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get all normal transactions for an address (handles pagination automatically)
   * @param address - The address to get transactions for
   * @param startBlock - Starting block number (optional)
   * @param endBlock - Ending block number (optional)
   * @param limit - Maximum number of transactions to return (optional)
   */
  async getAllTransactions(
    address: Address,
    startBlock?: number,
    endBlock?: number,
    limit?: number,
  ): Promise<EtherscanTransaction[]> {
    const allTransactions: EtherscanTransaction[] = [];
    let page = 1;
    const offset = 10000; // Max allowed by API

    while (true) {
      console.log(`📥 Fetching normal transactions page ${page}...`);
      const transactions = await this.getTransactions(
        address,
        startBlock,
        endBlock,
        page,
        offset,
      );

      if (transactions.length === 0) {
        break;
      }

      allTransactions.push(...transactions);

      if (limit && allTransactions.length >= limit) {
        console.log(`✅ Reached limit of ${limit} transactions`);
        return allTransactions.slice(0, limit);
      }

      // If we got fewer than offset, we've reached the end
      if (transactions.length < offset) {
        break;
      }

      page++;
    }

    return allTransactions;
  }

  /**
   * Get ERC20 token transfer events for an address
   * @param address - The address to get token transfers for
   * @param contractAddress - Filter by token contract address (optional)
   * @param startBlock - Starting block number (optional)
   * @param endBlock - Ending block number (optional)
   * @param page - Page number for pagination (optional)
   * @param offset - Number of transfers per page (optional, max 10000)
   */
  async getTokenTransfers(
    address: Address,
    contractAddress?: Address,
    startBlock?: number,
    endBlock?: number,
    page: number = 1,
    offset: number = 10000,
  ): Promise<EtherscanTokenTransfer[]> {
    const params: Record<string, string> = {
      module: "account",
      action: "tokentx",
      address,
      sort: "desc",
      page: page.toString(),
      offset: offset.toString(),
    };

    if (contractAddress) {
      params.contractaddress = contractAddress;
    }
    if (startBlock !== undefined) {
      params.startblock = startBlock.toString();
    }
    if (endBlock !== undefined) {
      params.endblock = endBlock.toString();
    }

    try {
      const result = await this.request<EtherscanTokenTransfer[]>(params);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      // If no transactions found, return empty array
      if (
        error instanceof Error &&
        error.message.includes("No transactions found")
      ) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get all ERC20 token transfers for an address (handles pagination automatically)
   * @param address - The address to get token transfers for
   * @param tokenConfigs - Token configurations with addresses and block ranges
   * @param startBlock - Starting block number (optional)
   * @param endBlock - Ending block number (optional)
   */
  async getAllTokenTransfers(
    address: Address,
    tokenConfigs?: Record<
      string,
      { address: Address; startBlock?: number; endBlock?: number }
    >,
    startBlock?: number,
    endBlock?: number,
  ): Promise<EtherscanTokenTransfer[]> {
    // If specific token configs are provided, fetch for each one
    if (tokenConfigs) {
      const allTransfers: EtherscanTokenTransfer[] = [];

      for (const [tokenName, config] of Object.entries(tokenConfigs)) {
        const tokenStartBlock = config.startBlock || startBlock;
        const tokenEndBlock = config.endBlock || endBlock;

        console.log(
          `🪙 Fetching token transfers for ${tokenName} (${config.address})...`,
        );
        let page = 1;
        const offset = 10000;

        while (true) {
          const transfers = await this.getTokenTransfers(
            address,
            config.address,
            tokenStartBlock,
            tokenEndBlock,
            page,
            offset,
          );

          if (transfers.length === 0) {
            break;
          }

          allTransfers.push(...transfers);

          if (transfers.length < offset) {
            break;
          }

          page++;
        }
      }

      return allTransfers;
    }

    // Otherwise, fetch all token transfers
    const allTransfers: EtherscanTokenTransfer[] = [];
    let page = 1;
    const offset = 10000;

    while (true) {
      console.log(`🪙 Fetching all token transfers page ${page}...`);
      const transfers = await this.getTokenTransfers(
        address,
        undefined,
        startBlock,
        endBlock,
        page,
        offset,
      );

      if (transfers.length === 0) {
        break;
      }

      allTransfers.push(...transfers);

      if (transfers.length < offset) {
        break;
      }

      page++;
    }

    return allTransfers;
  }
}

export type Monitor = {
  name: string;
  provider: "etherscan";
  chain: string;
  token: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
  };
  frequency: "daily";
  channelId: string;
  address: string;
};

const chainIdByChain = {
  gnosis: 100,
  base: 8453,
  base_sepolia: 84532,
  celo: 42220,
  polygon: 137,
};

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
 * Generic function to get transfers summary for a specific time range
 * @param monitor - Monitor configuration
 * @param startDate - Start date for the range
 * @param endDate - End date for the range
 * @param periodLabel - Label to use in the message (e.g., "yesterday", "last month")
 * @returns Summary message or null if no transactions
 */
export async function getTransfersSummary(
  monitor: Monitor,
  startDate: Date,
  endDate: Date,
  periodLabel: string,
) {
  const etherscan = new EtherscanClient(
    chainIdByChain[monitor.chain as keyof typeof chainIdByChain],
  );

  const startTimestamp = Math.floor(startDate.getTime() / 1000);
  const endTimestamp = Math.floor(endDate.getTime() / 1000);

  const transfers = await etherscan.getTokenTransfers(
    monitor.address as Address,
    monitor.token.address as Address,
  );
  const filteredTransfers = transfers.filter((transfer) =>
    Number(transfer.timeStamp) >= startTimestamp && Number(transfer.timeStamp) <= endTimestamp
  );

  const totalAmountIn =
    filteredTransfers.filter((t) => t.to.toLowerCase() === monitor.address.toLowerCase()).reduce(
      (acc, transfer) => acc + Number(transfer.value),
      0,
    ) / 10 ** monitor.token.decimals;

  const totalAmountOut =
    filteredTransfers.filter((t) => t.from.toLowerCase() === monitor.address.toLowerCase()).reduce(
      (acc, transfer) => acc + Number(transfer.value),
      0,
    ) / 10 ** monitor.token.decimals;

  if (totalAmountIn === 0 && totalAmountOut === 0) {
    console.log(`No transactions found for ${monitor.name} in ${periodLabel}`);
    return null;
  }

  // Format message based on period type
  const isMoreThanOneDay = (endDate.getTime() - startDate.getTime()) > 86400000;
  const isMonthly = periodLabel.startsWith("in ");
  const isWeekly = periodLabel === "last week";
  const isDaily = periodLabel === "yesterday";

  let message = "";

  const txLink = `https://txinfo.xyz/gnosis/token/${monitor.token.address}?a=${monitor.address}`;

  if (isWeekly) {
    // Weekly report format
    const weekNum = getWeekNumber(startDate);
    message = `${monitor.name} weekly report:\n`;
    message += `- 🗓️ Week ${weekNum} (${formatDate(startDate)}-${
      formatDate(endDate)
    }): [${filteredTransfers.length} ${
      pluralize("transaction", filteredTransfers.length)
    }](<${txLink}>)\n`;
    message += `- ↘️ ${totalAmountIn.toFixed(2)} ${monitor.token.symbol} (credit)\n`;
    message += `- ↗️ ${totalAmountOut.toFixed(2)} ${monitor.token.symbol} (debit)`;
  } else if (isMonthly) {
    // Monthly report format
    message = `${monitor.name} monthly report:\n`;
    message += `- 📅 ${periodLabel.replace("in ", "")}: [${filteredTransfers.length} ${
      pluralize("transaction", filteredTransfers.length)
    }](<${txLink}>)\n`;
    message += `- ↘️ ${totalAmountIn.toFixed(2)} ${monitor.token.symbol} (credit)\n`;
    message += `- ↗️ ${totalAmountOut.toFixed(2)} ${monitor.token.symbol} (debit)`;
  } else if (isDaily) {
    // Daily report format
    message = `${monitor.name} daily report:\n`;
    message += `- 📆 ${formatDate(startDate)}: [${filteredTransfers.length} ${
      pluralize("transaction", filteredTransfers.length)
    }](<${txLink}>)\n`;
    message += `- ↘️ ${totalAmountIn.toFixed(2)} ${monitor.token.symbol} (credit)\n`;
    message += `- ↗️ ${totalAmountOut.toFixed(2)} ${monitor.token.symbol} (debit)`;
  } else {
    // Fallback to old format for custom periods
    const dateDisplay = isMonthly
      ? ""
      : ` (${startDate.toLocaleDateString()}${
        isMoreThanOneDay ? ` - ${endDate.toLocaleDateString()}` : ""
      })`;
    message =
      `${monitor.name} transactions ${periodLabel}${dateDisplay}: ${filteredTransfers.length} ${
        pluralize("transaction", filteredTransfers.length)
      } for a total of ${totalAmountIn.toFixed(2)} ${monitor.token.symbol} in`;
    if (totalAmountOut > 0) {
      message += ` and ${totalAmountOut.toFixed(2)} ${monitor.token.symbol} out`;
    }
    message += `\n\n[View transactions](<${txLink}>)`;
  }

  return message;
}

/**
 * Get transfers summary for yesterday
 * @param monitor - Monitor configuration
 * @returns Summary message or null if no transactions
 */
export function getYesterdayTransfersSummary(monitor: Monitor) {
  const d = new Date(Deno.env.get("TODAY") || new Date());
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  return getTransfersSummary(monitor, startOfDay, endOfDay, "yesterday");
}

/**
 * Get transfers summary for the last month
 * @param monitor - Monitor configuration
 * @returns Summary message or null if no transactions
 */
export function getLastMonthTransfersSummary(monitor: Monitor) {
  const d = new Date(Deno.env.get("TODAY") || new Date());
  // Get first day of last month
  // Note: Both getMonth() and Date constructor use 0-indexed months (0=Jan, 11=Dec)
  // If today is November (month 10), last month October is month 9, so we use getMonth() - 1
  const startOfLastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  // Get first day of current month (which is the end boundary for last month's range)
  const endOfLastMonth = new Date(d.getFullYear(), d.getMonth(), 1);

  // Get the month name (e.g., "October")
  const monthName = startOfLastMonth.toLocaleString("en-US", { month: "long" });

  return getTransfersSummary(monitor, startOfLastMonth, endOfLastMonth, `in ${monthName}`);
}

/**
 * Get transfers summary for the last week
 * @param monitor - Monitor configuration
 * @returns Summary message or null if no transactions
 */
export function getLastWeekTransfersSummary(monitor: Monitor) {
  const d = new Date(Deno.env.get("TODAY") || new Date());
  const startOfWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
  const endOfWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  return getTransfersSummary(monitor, startOfWeek, endOfWeek, "last week");
}

/**
 * Create an Etherscan client from chain configuration
 * @param chainConfig - Chain configuration object with explorer_api URL
 * @param apiKey - Optional API key for higher rate limits
 */
export function createEtherscanClient(chainId: number): EtherscanClient {
  return new EtherscanClient(chainId);
}
