import { createPublicClient, createWalletClient, formatUnits, http, parseUnits } from "@wevm/viem";
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
const RPC_URLS = {
  celo: "https://celo-json-rpc.stakely.io",
  gnosis: "https://rpc.gnosischain.com",
  localhost: "http://127.0.0.1:8545",
} as const;

export type SupportedChain = keyof typeof RPC_URLS;

export async function deployContract(
  chainSlug: SupportedChain,
  contractName: string,
  accountAddress: Address,
  args: unknown[],
): Promise<Address> {
  const client = getWalletClient(chainSlug);
  const publicClient = createPublicClient({ transport: http(RPC_URLS[chainSlug]) });
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
  const hash = await client.deployContract({
    abi: contractAbi,
    account: accountAddress,
    chain: null,
    args: args,
    bytecode: contractBytecode as `0x${string}`,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress as Address;
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

  const client = createPublicClient({ transport: http(rpcUrl) });

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
  const client = createPublicClient({ transport: http(rpcUrl) });
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

  const publicClient = createPublicClient({ transport: http(RPC_URLS[params.chainSlug]) });
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

export function getWalletClient(chainSlug: SupportedChain): WalletClient {
  const pk = getEnv("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!pk) {
    throw new Error("PRIVATE_KEY environment variable is not set");
  }
  const account = privateKeyToAccount(pk);
  return createWalletClient({ account, transport: http(RPC_URLS[chainSlug]) });
}

export async function getBalance(
  chainSlug: SupportedChain,
  tokenAddress: string,
  address: string,
): Promise<bigint> {
  const client = createPublicClient({ transport: http(RPC_URLS[chainSlug]) });
  const res = await client.readContract({
    address: tokenAddress as Address,
    abi: ERC20_BURNABLE_ABI as Abi,
    functionName: "balanceOf",
    args: [address as Address],
  });
  return res as bigint;
}

export async function getNativeBalance(
  chainSlug: SupportedChain,
  address: string,
): Promise<bigint> {
  const client = createPublicClient({ transport: http(RPC_URLS[chainSlug]) });
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
  const client = createPublicClient({ transport: http(RPC_URLS[chainSlug]) });
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
