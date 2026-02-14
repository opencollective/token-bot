import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseUnits,
} from "@wevm/viem";
import type {
  Abi,
  Account,
  Address,
  Hash,
  PublicClient,
  TransactionReceipt,
  WalletClient,
  WriteContractParameters,
} from "@wevm/viem";

import { base, baseSepolia, celo, gnosis, localhost, polygon } from "@wevm/viem/chains";
import { privateKeyToAccount } from "@wevm/viem/accounts";
import { SimulateContractParameters } from "@wevm/viem/actions";
import ERC20_BURNABLE_ABI from "../abis/erc20-burnable.abi.json" with { type: "json" };
import accessControlABI from "../abis/IAccessControlUpgradeable.abi.json" with { type: "json" };
import { readCache, writeCache } from "./cache.ts";
import { getEnv } from "./utils.ts";

export const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";

export const PROFILE_ADMIN_ROLE =
  "0x224b562a599bb6f57441f98a50de513dff0de3d9b620f342c27a4e4a898ce8e2";

// Hard-coded RPC URLs for supported chains
export const RPC_URLS = {
  celo: "https://celo-json-rpc.stakely.io",
  gnosis: "https://rpc.gnosischain.com",
  base_sepolia: "https://base-sepolia-rpc.publicnode.com",
  base: "https://base.llamarpc.com",
  polygon: "https://polygon.llamarpc.com",
  localhost: "http://127.0.0.1:8545",
} as const;

export type SupportedChain = keyof typeof RPC_URLS;
export const ChainConfig = {
  "base_sepolia": baseSepolia,
  "base": base,
  "celo": celo,
  "gnosis": gnosis,
  "polygon": polygon,
  "localhost": defineChain({
    id: 31337,
    name: "Localhost",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: ["http://127.0.0.1:8545"] },
      public: { http: ["http://127.0.0.1:8545"] },
    },
    blockExplorers: { default: { name: "Localhost", url: "http://127.0.0.1:8545" } },
    testnet: true,
  }),
};

export async function deployContract(
  chainSlug: SupportedChain,
  contractName: string,
  args: unknown[],
): Promise<Address> {
  const client = getWalletClient(chainSlug);
  const publicClient = createPublicClient({
    chain: ChainConfig[chainSlug],
    transport: http(RPC_URLS[chainSlug]),
  });
  let contractJSON;
  const contractFilepath = `hardhat/artifacts/contracts/${contractName}.sol/${contractName}.json`;
  try {
    const contractRawData = await Deno.readTextFile(contractFilepath);
    contractJSON = JSON.parse(contractRawData);
  } catch (e) {
    throw new Error(`Failed to parse contract file: ${contractFilepath}`, { cause: e });
  }
  const contractAbi = contractJSON.abi;
  const contractBytecode = contractJSON.bytecode;
  try {
    console.log(
      ">>> Deploying contract on chain",
      chainSlug,
      "with address",
      client.account?.address,
      "balance:",
      await publicClient.getBalance({ address: client.account?.address as Address }),
    );
    const hash = await client.deployContract({
      abi: contractAbi,
      chain: ChainConfig[chainSlug],
      args: args,
      bytecode: contractBytecode as `0x${string}`,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress as Address;
  } catch (e) {
    if (e.details === "insufficient funds for transfer") {
      throw new Error(
        "Insufficient funds to deploy this token. Please send some ETH to " +
          client.account?.address + " on " + chainSlug,
      );
    }
    throw new Error(
      `Failed to deploy contract: ${contractName} on ${chainSlug}`,
      { cause: JSON.stringify(e) },
    );
  }
}

export async function getBlockchainTxInfo(
  chainSlug: SupportedChain,
  txHash: string,
  _provider?: unknown,
): Promise<TransactionReceipt | null> {
  const cache = readCache();
  const cacheKey = `${chainSlug}:${txHash}`;
  if (cache[cacheKey]) {
    return cache[cacheKey] as TransactionReceipt;
  }

  if (!(chainSlug in RPC_URLS)) {
    throw new Error(
      `Unsupported chain: ${chainSlug}. Supported chains: ${
        Object.keys(RPC_URLS).join(
          ", ",
        )
      }`,
    );
  }

  const chain = chainSlug as SupportedChain;
  const rpcUrl = RPC_URLS[chain];

  const client = createPublicClient({ transport: http(rpcUrl), chain: ChainConfig[chainSlug] });

  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hash });
    cache[cacheKey] = receipt;
    writeCache(cache);
    return receipt;
  } catch {
    // console.error(`Error fetching transaction ${txHash} on ${chain}:`, (error as Error).message);
    return null;
  }
}

export type Clients = { publicClient: PublicClient; walletClient: WalletClient; account?: Account };

export async function getBaseFee(chainSlug: string): Promise<bigint | undefined> {
  const rpcUrl = RPC_URLS[chainSlug as SupportedChain];
  console.log(">>> ChainConfig[chainSlug]", ChainConfig[chainSlug]);
  const client = createPublicClient({ transport: http(rpcUrl), chain: ChainConfig[chainSlug] });
  const fees = await getInitialGasParams(client);
  return fees.maxFeePerGas;
}

async function getInitialGasParams(publicClient: PublicClient): Promise<
  | { gasPrice: bigint; maxFeePerGas?: undefined; maxPriorityFeePerGas?: undefined }
  | { gasPrice?: undefined; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
> {
  try {
    // Prefer EIP-1559 if available
    const maybeEstimate = (publicClient as unknown as {
      estimateFeesPerGas?: () => Promise<{
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
      }>;
    }).estimateFeesPerGas;
    if (typeof maybeEstimate === "function") {
      const fees = await maybeEstimate();
      if (fees.maxFeePerGas && fees.maxPriorityFeePerGas) {
        return {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        };
      }
    }
  } catch {
    // ignore and fallback
  }
  // Legacy gas price fallback
  const gasPrice = await publicClient.getGasPrice();
  return { gasPrice };
}

function bumpGasParams(
  params:
    | { gasPrice: bigint; maxFeePerGas?: undefined; maxPriorityFeePerGas?: undefined }
    | { gasPrice?: undefined; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  bumpPercent: number,
) {
  const rounded = Math.round(bumpPercent);
  if ("gasPrice" in params && params.gasPrice !== undefined) {
    const bumped = (params.gasPrice * BigInt(100 + rounded)) / 100n;
    return { gasPrice: bumped } as const;
  }
  const bumpedMaxFee = (params.maxFeePerGas * BigInt(100 + rounded)) / 100n;
  const bumpedPriority = (params.maxPriorityFeePerGas * BigInt(100 + rounded)) / 100n;
  return { maxFeePerGas: bumpedMaxFee, maxPriorityFeePerGas: bumpedPriority } as const;
}

export async function submitTransaction(
  client: WalletClient,
  params: {
    chainSlug: SupportedChain;
    contractAddress: Address;
    abi: Abi;
    functionName: string;
    args: unknown[];
  },
  options?: {
    maxRetries?: number;
    timeoutMs?: number;
    gasBumpPercent?: number;
    nonce?: number;
  },
): Promise<Hash | null> {
  const maxRetries = options?.maxRetries ?? 3;
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const gasBumpPercent = options?.gasBumpPercent ?? 20;

  const DRY_RUN = getEnv("DRY_RUN") === "true";

  const publicClient = createPublicClient({
    transport: http(RPC_URLS[params.chainSlug]),
    chain: ChainConfig[params.chainSlug],
  });
  let gasParams = await getInitialGasParams(publicClient);
  const clientAddress = client.account?.address as Address;
  const nonce = options?.nonce ?? await publicClient.getTransactionCount({
    address: clientAddress,
    blockTag: "pending",
  });

  const writeContractParams = {
    address: params.contractAddress,
    abi: params.abi,
    chain: null,
    account: client.account as Account,
    functionName: params.functionName,
    args: params.args,
    nonce,
    ...gasParams,
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    console.log(
      writeContractParams.functionName,
      writeContractParams.args,
      "attempt",
      attempt,
      "nonce",
      nonce,
    );
    try {
      const { request } = await publicClient.simulateContract(
        writeContractParams as unknown as SimulateContractParameters,
      );
      if (DRY_RUN) {
        console.log(
          "DRY_RUN: would have submitted transaction with params:",
          writeContractParams.functionName,
          writeContractParams.args,
        );
        return "0x" + "1".repeat(64) as Hash;
      }
      const txHash = await client.writeContract(request as WriteContractParameters);
      const txPromise = publicClient.waitForTransactionReceipt({ hash: txHash });
      const timeoutPromise = new Promise<Hash | "__timeout__">((resolve) => {
        timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
      });
      const res = await Promise.race([txPromise, timeoutPromise]);

      if (res !== "__timeout__") {
        return txHash as Hash;
      }

      if (attempt === maxRetries) {
        console.log(
          "Max retries reached for transaction",
          writeContractParams.functionName,
          writeContractParams.args,
        );
        break;
      }
      gasParams = bumpGasParams(gasParams, gasBumpPercent);
      continue;
    } catch (err: unknown) {
      const code = (err as { code?: number; cause?: { code?: number } })?.code ?? (
        err as { cause?: { code?: number } }
      )?.cause?.code;
      if (code === -32000 && attempt < maxRetries) {
        gasParams = bumpGasParams(gasParams, gasBumpPercent);
        continue;
      }
      const msg = (err as { message?: string })?.message ?? "";
      // If previous attempt mined, this is expected — don't keep resending.
      if (msg.includes("Nonce provided") && msg.includes("lower than the current nonce")) {
        if (attempt === 1) {
          const newNonce = await publicClient.getTransactionCount({
            address: clientAddress,
            blockTag: "pending",
          });
          console.log(
            `Nonce provided (${writeContractParams.nonce}) lower than the current nonce, updating nonce to ${newNonce}`,
          );
          writeContractParams.nonce = newNonce;
        }
        console.log(
          "Previous attempt likely mined; not resending.",
          writeContractParams.functionName,
          writeContractParams.args,
        );
      }
      if (attempt === maxRetries) throw err;
      gasParams = bumpGasParams(gasParams, gasBumpPercent);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return null;
}

export async function deployTokenContract(
  chainSlug: SupportedChain,
  name: string,
  symbol: string,
): Promise<Address> {
  return await deployContract(chainSlug, "BurnableToken", [
    name,
    symbol,
  ]);
}

export function getWalletClient(chainSlug: SupportedChain): WalletClient {
  const pk = getEnv("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!pk) {
    throw new Error("PRIVATE_KEY environment variable is not set");
  }
  const account = privateKeyToAccount(pk);
  return createWalletClient({
    account,
    chain: ChainConfig[chainSlug],
    transport: http(RPC_URLS[chainSlug]),
  });
}

export async function getBalance(
  chainSlug: SupportedChain,
  tokenAddress: string,
  address: string,
): Promise<bigint> {
  const client = createPublicClient({
    transport: http(RPC_URLS[chainSlug]),
    chain: ChainConfig[chainSlug],
  });
  const res = await client.readContract({
    address: tokenAddress as Address,
    abi: ERC20_BURNABLE_ABI as Abi,
    functionName: "balanceOf",
    args: [address as Address],
  });
  return res as bigint;
}

export async function getTotalSupply(
  chainSlug: SupportedChain,
  tokenAddress: string,
): Promise<bigint> {
  const client = createPublicClient({
    transport: http(RPC_URLS[chainSlug]),
    chain: ChainConfig[chainSlug],
  });
  const res = await client.readContract({
    address: tokenAddress as Address,
    abi: ERC20_BURNABLE_ABI as Abi,
    functionName: "totalSupply",
    args: [],
  });
  return res as bigint;
}

// Block explorer API URLs for fetching token holder count
const EXPLORER_API_URLS: Record<SupportedChain, string | null> = {
  celo: "https://api.celoscan.io/api",
  gnosis: "https://api.gnosisscan.io/api",
  base: "https://api.basescan.org/api",
  base_sepolia: "https://api-sepolia.basescan.org/api",
  polygon: "https://api.polygonscan.com/api",
  localhost: null,
};

export async function getTokenHolderCount(
  chainSlug: SupportedChain,
  tokenAddress: string,
): Promise<number | null> {
  const apiUrl = EXPLORER_API_URLS[chainSlug];
  if (!apiUrl) return null;

  try {
    // Use the tokenholderlist endpoint to get holder count
    const response = await fetch(
      `${apiUrl}?module=token&action=tokeninfo&contractaddress=${tokenAddress}`
    );
    const data = await response.json();
    
    if (data.status === "1" && data.result?.[0]?.holdersCount) {
      return parseInt(data.result[0].holdersCount, 10);
    }
    
    // Fallback: try tokenholderlist (some explorers use this)
    const response2 = await fetch(
      `${apiUrl}?module=token&action=tokenholderlist&contractaddress=${tokenAddress}&page=1&offset=1`
    );
    const data2 = await response2.json();
    
    // If we get a result, there's at least 1 holder; the API doesn't give total count easily
    // So we return null if we can't get the exact count
    return null;
  } catch (error) {
    console.error(`Error fetching holder count for ${tokenAddress}:`, error);
    return null;
  }
}

export async function getNativeBalance(
  chainSlug: SupportedChain,
  address: string,
): Promise<bigint> {
  const client = createPublicClient({
    transport: http(RPC_URLS[chainSlug]),
    chain: ChainConfig[chainSlug],
  });
  return await client.getBalance({ address: address as Address });
}

export async function mintTokens(
  chainSlug: SupportedChain,
  tokenAddress: string,
  toAddress: string,
  amount: string,
  decimals: number = 6,
): Promise<Hash | null> {
  const client = getWalletClient(chainSlug);
  const [address] = await client.getAddresses();

  const hasMinter = await hasRole(chainSlug, tokenAddress, MINTER_ROLE, address);
  if (!hasMinter) {
    throw new Error(
      `Signer (${address}) does not have the MINTER_ROLE on token contract ${tokenAddress}`,
    );
  }

  const amountWei = parseUnits(amount, decimals);

  return await submitTransaction(client, {
    chainSlug,
    contractAddress: tokenAddress as Address,
    abi: ERC20_BURNABLE_ABI as Abi,
    functionName: "mint",
    args: [toAddress as Address, amountWei],
  });
}

export async function burnTokens(
  chainSlug: SupportedChain,
  tokenAddress: string,
  amount: string,
): Promise<Hash | null> {
  const client = getWalletClient(chainSlug);

  const amountWei = parseUnits(amount, 18);

  return await submitTransaction(client, {
    chainSlug,
    contractAddress: tokenAddress as Address,
    abi: ERC20_BURNABLE_ABI as Abi,
    functionName: "burn",
    args: [amountWei],
  });
}

export async function burnTokensFrom(
  chainSlug: SupportedChain,
  tokenAddress: string,
  fromAddress: string,
  amount: string,
  decimals: number = 6,
): Promise<Hash | null> {
  const client = getWalletClient(chainSlug);

  const amountWei = parseUnits(amount, decimals);

  const balance = await getBalance(chainSlug, tokenAddress, fromAddress);
  if (balance < amountWei) {
    throw new Error(
      `Insufficient balance (${
        formatUnits(balance, decimals)
      } < ${amount}) for ${fromAddress} on ${tokenAddress})`,
    );
  }

  return await submitTransaction(client, {
    chainSlug,
    contractAddress: tokenAddress as Address,
    abi: ERC20_BURNABLE_ABI as Abi,
    functionName: "burnFrom",
    args: [fromAddress as Address, amountWei],
  });
}

export function isFunctionInABI(
  func: string,
  abi: Array<{ type?: string; name?: string }>,
): boolean {
  return abi.some((item) => item.type === "function" && item.name === func);
}

export async function hasRole(
  chainSlug: SupportedChain,
  tokenAddress: string,
  role: string,
  account: string,
) {
  const client = createPublicClient({
    transport: http(RPC_URLS[chainSlug]),
    chain: ChainConfig[chainSlug],
  });
  if (role === "minter") {
    role = MINTER_ROLE;
  } else if (role === "profile_admin") {
    role = PROFILE_ADMIN_ROLE;
  }

  return await client.readContract({
    address: tokenAddress as Address,
    abi: accessControlABI as Abi,
    functionName: "hasRole",
    args: [role, account as Address],
  });
}

/**
 * Get the token contract address from a transaction hash
 * The "to" field of a token transfer/burn transaction is the token contract
 */
export async function getTokenAddressFromTx(
  chainSlug: SupportedChain,
  txHash: string,
): Promise<string | null> {
  try {
    const client = createPublicClient({
      transport: http(RPC_URLS[chainSlug]),
      chain: ChainConfig[chainSlug],
    });

    const tx = await client.getTransaction({
      hash: txHash as Hash,
    });

    // The "to" address is the token contract
    return tx.to || null;
  } catch (error) {
    console.error(`Error getting token from tx ${txHash}:`, error);
    return null;
  }
}
