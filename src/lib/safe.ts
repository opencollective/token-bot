import {
  Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodePacked,
  getContractAddress,
  http,
  keccak256,
  parseAbiParameters,
  toHex,
  zeroAddress,
} from "@wevm/viem";
import { privateKeyToAccount } from "@wevm/viem/accounts";
import { getEnv } from "./utils.ts";
import { ChainConfig, RPC_URLS, SupportedChain } from "./blockchain.ts";

// Safe Proxy Factory address (canonical deployment across networks)
// Note: For localhost testing, these contracts need to be deployed first
// On production chains (base, celo, gnosis, etc.), these are pre-deployed at these addresses
const SAFE_PROXY_FACTORY_ADDRESS = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address;

// Safe Singleton address (canonical Safe v1.4.1)
const SAFE_SINGLETON_ADDRESS = "0x41675C099F32341bf84BFc5382aF534df5C7461a" as Address;

// Fallback Handler address
const FALLBACK_HANDLER_ADDRESS = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as Address;

/**
 * Get the addresses of the Safe owners from environment variables
 */
function getAccountsFromEnv(): { primary: Address; backup: Address } {
  const pk = getEnv("PRIVATE_KEY") as `0x${string}` | undefined;
  const backupPk = getEnv("BACKUP_PRIVATE_KEY") as `0x${string}` | undefined;

  if (!pk) {
    throw new Error("PRIVATE_KEY environment variable is not set");
  }
  if (!backupPk) {
    throw new Error("BACKUP_PRIVATE_KEY environment variable is not set");
  }

  const primaryAccount = privateKeyToAccount(pk);
  const backupAccount = privateKeyToAccount(backupPk);

  return {
    primary: primaryAccount.address,
    backup: backupAccount.address,
  };
}

/**
 * Generate a deterministic salt nonce from a Discord user ID
 */
function generateSaltNonce(discordUserId: string): bigint {
  // Hash the discord user ID to create a deterministic salt
  const hash = keccak256(toHex(discordUserId));
  // Convert to bigint
  return BigInt(hash);
}

/**
 * Encode Safe setup data
 * This calls the Safe's setup function with the specified parameters
 */
function encodeSafeSetup(owners: Address[], threshold: number): `0x${string}` {
  // Safe setup function: setup(address[],uint256,address,bytes,address,address,uint256,address)
  // Function selector: 0xb63e800d

  const setupData = encodeAbiParameters(
    parseAbiParameters(
      "address[], uint256, address, bytes, address, address, uint256, address",
    ),
    [
      owners, // _owners
      BigInt(threshold), // _threshold
      zeroAddress, // to (no delegate call)
      "0x", // data (no delegate call data)
      FALLBACK_HANDLER_ADDRESS, // fallbackHandler
      zeroAddress, // paymentToken (no payment)
      0n, // payment (no payment)
      zeroAddress, // paymentReceiver (no payment)
    ],
  );

  // Function selector for setup
  const setupSelector = "0xb63e800d";
  return (setupSelector + setupData.slice(2)) as `0x${string}`;
}

/**
 * Calculate the counterfactual Safe address using CREATE2
 * This predicts where the Safe will be deployed without actually deploying it
 */
function predictSafeAddress(
  owners: Address[],
  threshold: number,
  saltNonce: bigint,
): Address {
  // Encode the initializer (Safe setup call)
  const initializer = encodeSafeSetup(owners, threshold);
  const initializerHash = keccak256(initializer);

  // Calculate the salt for CREATE2
  // salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce))
  const salt = keccak256(
    encodePacked(["bytes32", "uint256"], [initializerHash, saltNonce]),
  );

  // The Safe Proxy Factory uses CREATE2 with:
  // - The proxy bytecode that delegates to the singleton
  // - The salt calculated above

  // The deployment bytecode includes the constructor that sets the singleton address
  const deploymentBytecode = encodePacked(
    ["bytes", "uint256"],
    [
      "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260248152602001806101c26024913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe" as `0x${string}`,
      BigInt(SAFE_SINGLETON_ADDRESS),
    ],
  );

  const bytecodeHash = keccak256(deploymentBytecode);

  // Calculate CREATE2 address
  const predictedAddress = getContractAddress({
    opcode: "CREATE2",
    from: SAFE_PROXY_FACTORY_ADDRESS,
    salt,
    bytecodeHash,
  });

  return predictedAddress;
}

/**
 * Get the deterministic Safe address for a Discord user ID
 * Returns a counterfactual address (predicted address before deployment)
 * @param discordUserId - The Discord user ID to generate a Safe address for
 * @param _chainSlug - The blockchain network (optional, defaults to CHAIN env var)
 * @returns The predicted Safe address
 */
export function getSAFEAddress(
  discordUserId: string,
  _chainSlug?: SupportedChain,
): Address {
  const accounts = getAccountsFromEnv();
  const saltNonce = generateSaltNonce(discordUserId);

  // Safe configuration with threshold of 1 (either owner can sign)
  // Owners are sorted to ensure deterministic address generation
  const owners = [accounts.primary, accounts.backup].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  const threshold = 1;

  // Predict the Safe address
  const predictedAddress = predictSafeAddress(owners, threshold, saltNonce);

  return predictedAddress;
}

/**
 * Deploy a Safe for a Discord user ID
 * This function is idempotent - if the Safe already exists, it returns the existing address
 * @param discordUserId - The Discord user ID to deploy a Safe for
 * @param chainSlug - The blockchain network (optional, defaults to CHAIN env var)
 * @returns The deployed or existing Safe address
 */
export async function deploySAFE(
  discordUserId: string,
  chainSlug?: SupportedChain,
): Promise<Address> {
  const chain = (chainSlug || getEnv("CHAIN") || "localhost") as SupportedChain;

  // Get the predicted Safe address
  const predictedAddress = getSAFEAddress(discordUserId, chain);

  // Check if Safe already exists at this address
  const publicClient = createPublicClient({
    chain: ChainConfig[chain],
    transport: http(RPC_URLS[chain]),
  });

  const code = await publicClient.getCode({ address: predictedAddress });

  // If code exists, the Safe is already deployed
  if (code && code !== "0x") {
    console.log(`Safe already exists at ${predictedAddress}`);
    return predictedAddress;
  }

  // Deploy the Safe
  const pk = getEnv("PRIVATE_KEY") as `0x${string}` | undefined;
  if (!pk) {
    throw new Error("PRIVATE_KEY environment variable is not set");
  }

  const account = privateKeyToAccount(pk);
  const walletClient = createWalletClient({
    account,
    chain: ChainConfig[chain],
    transport: http(RPC_URLS[chain]),
  });

  const accounts = getAccountsFromEnv();
  const saltNonce = generateSaltNonce(discordUserId);

  // Owners are sorted to ensure deterministic address generation
  const owners = [accounts.primary, accounts.backup].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  const threshold = 1;
  const initializer = encodeSafeSetup(owners, threshold);

  // Safe Proxy Factory ABI (createProxyWithNonce function)
  const proxyFactoryABI = [
    {
      inputs: [
        { name: "_singleton", type: "address" },
        { name: "initializer", type: "bytes" },
        { name: "saltNonce", type: "uint256" },
      ],
      name: "createProxyWithNonce",
      outputs: [{ name: "proxy", type: "address" }],
      stateMutability: "nonpayable",
      type: "function",
    },
  ] as const;

  console.log(`Deploying Safe for Discord user ${discordUserId} on ${chain}...`);
  console.log(`Predicted address: ${predictedAddress}`);

  try {
    const hash = await walletClient.writeContract({
      address: SAFE_PROXY_FACTORY_ADDRESS,
      abi: proxyFactoryABI,
      functionName: "createProxyWithNonce",
      args: [SAFE_SINGLETON_ADDRESS, initializer, saltNonce],
    });

    const _receipt = await publicClient.waitForTransactionReceipt({ hash });

    console.log(`Safe deployed at ${predictedAddress} (tx: ${hash})`);
    return predictedAddress;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to deploy Safe: ${errorMessage}. Note: Safe contracts must be deployed on the network first.`,
    );
  }
}
