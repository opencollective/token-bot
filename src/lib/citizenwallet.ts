import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import { RPC_URLS, SupportedChain } from "./blockchain.ts";
import type { Token } from "../types.ts";

const cardManagerModuleAbi = [
  {
    type: "function",
    name: "getCardAddress",
    inputs: [
      { name: "id", type: "bytes32", internalType: "bytes32" },
      { name: "hashedSerial", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
];

// Default CardManager on Celo (CHT)
const DEFAULT_CARD_MANAGER_ADDRESS = "0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28";
const DEFAULT_INSTANCE_ID = "cw-discord-1";

/**
 * Resolve a Discord user's wallet address for a specific token.
 *
 * Routes to the correct wallet manager:
 * - "citizenwallet": resolves via CardManager contract (default)
 * - "opencollective": resolves via @opencollective/token-factory (Safe address prediction)
 */
export async function getAccountAddressForToken(
  userId: string,
  token: Token,
): Promise<string | null> {
  const manager = token.walletManager || "citizenwallet";

  if (manager === "opencollective") {
    return resolveOpenCollectiveAddress(userId, token);
  }

  return resolveCitizenWalletAddress(userId, token);
}

// ── OpenCollective (Safe-based) ─────────────────────────────────────────────

async function resolveOpenCollectiveAddress(
  userId: string,
  token: Token,
): Promise<string | null> {
  try {
    const { Token: OCToken } = await import("@opencollective/token-factory");
    const ocToken = new OCToken({
      name: token.name,
      symbol: token.symbol,
      chain: token.chain,
      tokenAddress: token.address,
    });
    const address = ocToken.getUserAddress("discord", userId);
    return address;
  } catch (error) {
    console.error(
      `Error resolving OpenCollective address for ${userId} on ${token.chain}:`,
      error,
    );
    return null;
  }
}

// ── Citizen Wallet (CardManager-based) ──────────────────────────────────────

async function resolveCitizenWalletAddress(
  userId: string,
  token: Token,
): Promise<string | null> {
  const cardManagerAddress = token.cardManagerAddress || DEFAULT_CARD_MANAGER_ADDRESS;
  const instanceId = token.cardManagerInstanceId || DEFAULT_INSTANCE_ID;

  // Default CardManager is on Celo; token-specific ones are on the token's chain
  const cardManagerChain: SupportedChain = token.cardManagerAddress
    ? (token.chain as SupportedChain)
    : "celo";

  const rpcUrl = getRpcUrl(cardManagerChain);
  const rpc = new JsonRpcProvider(rpcUrl);

  try {
    const contract = new Contract(cardManagerAddress, cardManagerModuleAbi, rpc);
    const hashedInstanceId = keccak256(toUtf8Bytes(instanceId));
    const hashedUserId = keccak256(toUtf8Bytes(userId));

    const accountAddress = await contract.getFunction("getCardAddress")(
      hashedInstanceId,
      hashedUserId,
    );

    return accountAddress;
  } catch (error) {
    console.error(
      `Error resolving CW address for ${userId} on ${cardManagerChain}:`,
      error,
    );
    return null;
  } finally {
    rpc.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ── Legacy exports (backward compat) ────────────────────────────────────────

export const getAccountAddressFromDiscordUserId = async (
  userId: string,
): Promise<string | null> => {
  const rpcUrl = getRpcUrl("celo");
  const rpc = new JsonRpcProvider(rpcUrl);

  try {
    const contract = new Contract(DEFAULT_CARD_MANAGER_ADDRESS, cardManagerModuleAbi, rpc);
    const hashedInstanceId = keccak256(toUtf8Bytes(DEFAULT_INSTANCE_ID));
    const hashedUserId = keccak256(toUtf8Bytes(userId));
    return await contract.getFunction("getCardAddress")(hashedInstanceId, hashedUserId);
  } catch (error) {
    console.error("Error fetching account address:", error);
    return null;
  } finally {
    rpc.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

export const getCardAddress = async (
  hashedSerial: string,
): Promise<string | null> => {
  const rpcUrl = getRpcUrl("celo");
  const rpc = new JsonRpcProvider(rpcUrl);

  try {
    const contract = new Contract(DEFAULT_CARD_MANAGER_ADDRESS, cardManagerModuleAbi, rpc);
    const hashedInstanceId = keccak256(toUtf8Bytes(DEFAULT_INSTANCE_ID));
    return await contract.getFunction("getCardAddress")(hashedInstanceId, hashedSerial);
  } catch (error) {
    console.error("Error fetching account address:", error);
    return null;
  } finally {
    rpc.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

function getRpcUrl(chain: SupportedChain): string {
  if (chain === "celo") {
    const envUrl = typeof Deno !== "undefined" ? Deno.env.get("CELO_RPC_URL") : undefined;
    if (envUrl) return envUrl;
  }
  return RPC_URLS[chain];
}
