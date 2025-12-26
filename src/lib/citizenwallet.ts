import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";

const cardManagerModuleAbi = [
  {
    "type": "function",
    "name": "getCardAddress",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32",
      },
      {
        "name": "hashedSerial",
        "type": "bytes32",
        "internalType": "bytes32",
      },
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address",
      },
    ],
    "stateMutability": "view",
  },
  {
    "type": "function",
    "name": "getCardHash",
    "inputs": [
      {
        "name": "id",
        "type": "bytes32",
        "internalType": "bytes32",
      },
      {
        "name": "hashedSerial",
        "type": "bytes32",
        "internalType": "bytes32",
      },
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32",
      },
    ],
    "stateMutability": "view",
  },
  {
    "type": "function",
    "name": "getInstanceId",
    "inputs": [
      {
        "name": "salt",
        "type": "uint256",
        "internalType": "uint256",
      },
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32",
      },
    ],
    "stateMutability": "view",
  },
];

const CARD_MANAGER_ADDRESS = "0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28"; // CHT Card Manager deployed by Citizen Wallet

export const getCardAddress = async (
  hashedSerial: string,
): Promise<string | null> => {
  const rpcUrl = Deno.env.get("CELO_RPC_URL");

  if (!rpcUrl) {
    throw new Error("CELO_RPC_URL is not set");
  }

  const rpc = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(CARD_MANAGER_ADDRESS, cardManagerModuleAbi, rpc);

  const hashedInstanceId = keccak256(toUtf8Bytes("cw-discord-1")); // instance_id of the CHT Card Manager

  try {
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

export const getAccountAddressFromDiscordUserId = async (userId: string) => {
  const hashedUserId = keccak256(toUtf8Bytes(userId));

  const cardAddress = await getCardAddress(hashedUserId);

  return cardAddress;
};
