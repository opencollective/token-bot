export type BlockchainAddress = `0x${string}`;
export type Chain = "celo" | "gnosis" | "base" | "base_sepolia" | "polygon";

export type Token = {
  name: string;
  symbol: string;
  decimals: number;
  chain: Chain;
  address: BlockchainAddress;
  mintable?: boolean;
  mintInstructions?: string;
};

export type GuildSettings = {
  tokens: Token[];
  guild: {
    id: string;
    name: string;
    icon: string | null;
    timezone?: string;
  };
  creator: {
    id: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
  };
  channels: {
    transactions: string;
    contributions: string;
    logs: string;
  };
};

export type RoleSetting = {
  id: string;
  name: string;
  amountToMint?: number;
  amountToBurn?: number;
  frequency: "daily" | "weekly" | "monthly";
  gracePeriod?: number;
  rolesToPingIfEmpty: string[];
  onlyToActiveContributors: boolean;
};

// State management types
export type TokenSetupState = {
  step: "choice" | "chain" | "token" | "create_token";
  useExisting?: boolean;
  chain?: Chain;
  tokenAddress?: BlockchainAddress;
  tokenName?: string;
  tokenSymbol?: string;
};

export type ChannelSetupState = {
  transactions?: string;
  contributions?: string;
  logs?: string;
};

export type RewardEditState = {
  id?: string;
  amountToMint: number;
  frequency?: "daily" | "weekly" | "monthly";
  rolesToPingIfEmpty: string[];
  onlyToActiveContributors?: boolean;
};

export type CostEditState = {
  id?: string;
  amountToBurn: number;
  frequency?: "daily" | "weekly" | "monthly";
  rolesToPingIfEmpty: string[];
  onlyToActiveContributors?: boolean;
};

export type Product = {
  type: "room";
  unit: "hour";
  slug: string;
  name: string;
  capacity?: number;
  availabilities: string;
  calendarId?: string;
  channelId?: string;
  price: {
    token: string;
    amount: number;
  }[];
};

export type BookState = {
  step?: "room" | "date" | "time" | "duration" | "name" | "confirm";
  productSlug?: string;
  guildId?: string;
  name?: string;
  selectedDate?: Date;
  selectedHour?: number;
  selectedMinute?: number;
  startTime?: Date;
  endTime?: Date;
  duration?: number;
};
