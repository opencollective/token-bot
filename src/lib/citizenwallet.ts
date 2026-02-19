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
 * Resolve a Discord user's wallet address for a specific token/chain.
 *
 * Uses the token's cardManagerAddress if set, otherwise falls back to
 * the default Celo CardManager. The RPC is chosen based on the chain
 * where the CardManager is deployed (Celo for default, or the token's chain).
 */
export async function getAccountAddressForToken(
  userId: string,
  token: Token,
): Promise<string | null> {
  const cardManagerAddress = token.cardManagerAddress || DEFAULT_CARD_MANAGER_ADDRESS;
  const instanceId = token.cardManagerInstanceId || DEFAULT_INSTANCE_ID;

  // Determine which chain the CardManager lives on
  // If using the default CardManager, it's on Celo regardless of token chain
  // If using a token-specific CardManager, it's on the token's chain
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
      `Error resolving address for ${userId} on ${cardManagerChain} ` +
      `(CardManager: ${cardManagerAddress}, instance: ${instanceId}):`,
      error,
    );
    return null;
  } finally {
    rpc.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Legacy function — resolves address using default Celo CardManager.
 * Prefer getAccountAddressForToken() for chain-aware resolution.
 */
export const getAccountAddressFromDiscordUserId = async (
  userId: string,
): Promise<string | null> => {
  const rpcUrl = getRpcUrl("celo");
  const rpc = new JsonRpcProvider(rpcUrl);

  try {
    const contract = new Contract(DEFAULT_CARD_MANAGER_ADDRESS, cardManagerModuleAbi, rpc);
    const hashedInstanceId = keccak256(toUtf8Bytes(DEFAULT_INSTANCE_ID));
    const hashedUserId = keccak256(toUtf8Bytes(userId));

    const accountAddress = await contract.getFunction("getCardAddress")(
      hashedInstanceId,
      hashedUserId,
    );

    return accountAddress;
  } catch (error) {
    console.error("Error fetching account address:", error);
    return null;
  } finally {
    rpc.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

// Legacy export for backward compat
export const getCardAddress = async (
  hashedSerial: string,
): Promise<string | null> => {
  const rpcUrl = getRpcUrl("celo");
  const rpc = new JsonRpcProvider(rpcUrl);

  try {
    const contract = new Contract(DEFAULT_CARD_MANAGER_ADDRESS, cardManagerModuleAbi, rpc);
    const hashedInstanceId = keccak256(toUtf8Bytes(DEFAULT_INSTANCE_ID));

    const accountAddress = await contract.getFunction("getCardAddress")(
      hashedInstanceId,
      hashedSerial,
    );

    return accountAddress;
  } catch (error) {
    console.error("Error fetching account address:", error);
    return null;
  } finally {
    rpc.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

function getRpcUrl(chain: SupportedChain): string {
  // Prefer env var for Celo (legacy behavior)
  if (chain === "celo") {
    const envUrl = typeof Deno !== "undefined" ? Deno.env.get("CELO_RPC_URL") : undefined;
    if (envUrl) return envUrl;
  }
  return RPC_URLS[chain];
}
