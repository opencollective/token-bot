import { JsonRpcProvider, keccak256, toUtf8Bytes, Contract } from "npm:ethers";


export const getAccountAddressFromDiscordUserId = async (userId: string) => {
  const hashedUserId = keccak256(toUtf8Bytes(userId));

  const cardAddress = await getCardAddress(hashedUserId);

  return cardAddress;
};

import cardManagerModuleAbi from "../abis/CardManagerModule.abi.json" with { type: "json" };

type CommunityConfig = {
  community: {
    name: string;
    description: string;
    url: string;
    alias: string;
    custom_domain: string;
    logo: string;
    theme: {
      primary: string;
    };
    profile: {
      address: string;
      chain_id: number;
    };
    primary_token: {
      address: string;
      chain_id: number;
    };
    primary_account_factory: {
      address: string;
      chain_id: number;
    };
    primary_card_manager: {
      address: string;
      chain_id: number;
    };
  };
  tokens: {
    [key: string]: {
      standard: string;
      name: string;
      address: string;
      symbol: string;
      decimals: number;
      chain_id: number;
    };
  };
  scan: {
    url: string;
    name: string;
  };
  accounts: {
    [key: string]: {
      chain_id: number;
      entrypoint_address: string;
      paymaster_address: string;
      account_factory_address: string;
      paymaster_type: string;
    };
  };
  cards: {
    [key: string]: {
      chain_id: number;
      instance_id: string;
      address: string;
      type: string;
    };
  };
  chains: {
    [key: string]: {
      id: number;
      node: {
        url: string;
        ws_url: string;
      };
    };
  };
  ipfs: {
    url: string;
  };
  plugins: Array<{
    name: string;
    icon: string;
    url: string;
    launch_mode: string;
  }>;
  config_location: string;
  version: number;
}

import communityJson from "../../community.json" with { type: "json" };
const communityConfig = communityJson as unknown as CommunityConfig;


const CARD_MANAGER_ADDRESS = communityConfig?.community?.primary_card_manager?.address;

export const getCardAddress = async (
  hashedSerial: string,
): Promise<string | null> => {

  const rpcUrl = Deno.env.get("CELO_RPC_URL");

  if (!rpcUrl) {
    throw new Error("CELO_RPC_URL is not set");
  }

  const rpc = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(CARD_MANAGER_ADDRESS, cardManagerModuleAbi, rpc);

  const hashedInstanceId = keccak256(toUtf8Bytes(communityConfig.cards[`${communityConfig?.community?.primary_card_manager?.chain_id}:${CARD_MANAGER_ADDRESS}`].instance_id));

  try {
    const accountAddress = await contract.getFunction("getCardAddress")(
      hashedInstanceId,
      hashedSerial
    );

    return accountAddress;
  } catch (error) {
    console.error("Error fetching account address:", error);

    return null;
  }
  finally {
    rpc.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};