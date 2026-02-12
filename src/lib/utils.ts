import { join } from "@std/path";
import { GuildSettings, RoleSetting, Token } from "../types.ts";
import { ensureDir } from "@std/fs/ensure-dir";

type MessageAction = {
  type: "burn" | "mint";
  amount: string;
  currency: string;
  description: string;
  txHash: string;
  discordUserId: string;
  accountAddress: string;
};

export function parseMessageContent(
  messageContent: string,
): MessageAction | null {
  const result: MessageAction = {
    type: "burn",
    amount: "0",
    currency: "CHT",
    description: "",
    txHash: "",
    discordUserId: "",
    accountAddress: "",
  };

  const matches = messageContent.match(
    /(Burned|Minted) ([0-9]+) ([A-Z]{2,5}) [a-z]+.*<@([0-9]+)>(?: for (.*))?.*\(\[.*\/tx\/(0x.{64})(?:.*\/address\/(0x.{40})*)?/im,
  );
  if (matches) {
    result.type = matches[1] === "Burned" ? "burn" : "mint";
    result.amount = matches[2];
    result.currency = matches[3];
    result.discordUserId = matches[4];
    result.description = (matches[5] || "").trim();
    result.txHash = matches[6];
    result.accountAddress = matches[7];
  } else {
    return null;
  }
  return result;
}

export function getEnv(key: string): string | undefined {
  try {
    if (typeof Deno !== "undefined" && Deno.env?.get) return Deno.env.get(key);
  } catch {
    // ignore
  }
  if (typeof process !== "undefined") return process.env[key];
  return undefined;
}

// Get data directory from env or default to ./data
function getDataDir(): string {
  return getEnv("DATA_DIR") || "./data";
}

// Settings cache (10 second TTL for fast autocomplete)
const settingsCache = new Map<string, { data: GuildSettings; expiry: number }>();
const CACHE_TTL_MS = 10_000;

export function invalidateSettingsCache(guildId: string): void {
  settingsCache.delete(guildId);
}

// Migrate legacy settings (contributionToken/fiatToken) to tokens array
function migrateSettings(raw: any): GuildSettings {
  const tokens: Token[] = raw.tokens || [];

  // Migrate contributionToken if exists and not already in tokens
  if (raw.contributionToken?.address) {
    const exists = tokens.some(
      (t) =>
        t.address.toLowerCase() === raw.contributionToken.address.toLowerCase(),
    );
    if (!exists) {
      tokens.unshift({
        name: raw.contributionToken.name,
        symbol: raw.contributionToken.symbol,
        decimals: raw.contributionToken.decimals,
        chain: raw.contributionToken.chain,
        address: raw.contributionToken.address,
        mintable: true, // Legacy contributionToken was always mintable
      });
    }
  }

  // Migrate fiatToken if exists and not already in tokens
  if (raw.fiatToken?.address) {
    const exists = tokens.some(
      (t) => t.address.toLowerCase() === raw.fiatToken.address.toLowerCase(),
    );
    if (!exists) {
      tokens.push({
        name: raw.fiatToken.name,
        symbol: raw.fiatToken.symbol,
        decimals: raw.fiatToken.decimals,
        chain: raw.fiatToken.chain,
        address: raw.fiatToken.address,
        mintable: false, // Fiat tokens typically not mintable by bot
      });
    }
  }

  return {
    tokens,
    guild: raw.guild,
    creator: raw.creator,
    channels: raw.channels || { transactions: "", contributions: "", logs: "" },
  };
}

export async function loadGuildFile(
  guildId: string,
  filename: string,
): Promise<any | null> {
  try {
    const dataDir = getDataDir();
    const path = join(dataDir, guildId, filename);
    const content = await Deno.readTextFile(path);
    return JSON.parse(content);
  } catch (error) {
    console.error(
      `Error loading guild file ${filename} for guild ${guildId}:`,
      error,
    );
    return null;
  }
}

export async function loadGuildSettings(
  guildId: string,
): Promise<GuildSettings | null> {
  // Check cache first
  const cached = settingsCache.get(guildId);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  const raw = await loadGuildFile(guildId, "settings.json");
  if (!raw) return null;

  const settings = migrateSettings(raw);

  // Cache the result
  settingsCache.set(guildId, {
    data: settings,
    expiry: Date.now() + CACHE_TTL_MS,
  });

  return settings;
}

// File system helpers
async function getDataPath(
  guildId: string,
  filename: string,
): Promise<string> {
  const dataDir = getDataDir();
  const dirPath = `${dataDir}/${guildId}`;
  await ensureDir(dirPath);
  return `${dirPath}/${filename}`;
}

export async function saveGuildSettings(
  guildId: string,
  settings: GuildSettings,
): Promise<void> {
  const path = await getDataPath(guildId, "settings.json");
  await Deno.writeTextFile(path, JSON.stringify(settings, null, 2));
  // Invalidate cache after save
  invalidateSettingsCache(guildId);
}

export async function loadRoles(guildId: string): Promise<RoleSetting[]> {
  return ((await loadGuildFile(guildId, "roles.json")) as RoleSetting[]) || [];
}

export async function saveRoles(
  guildId: string,
  roles: RoleSetting[],
): Promise<void> {
  const path = await getDataPath(guildId, "roles.json");
  await Deno.writeTextFile(path, JSON.stringify(roles, null, 2));
}
