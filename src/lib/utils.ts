import { join } from "@std/path";
import { GuildSettings, RoleSetting } from "../types.ts";
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

export async function loadGuildFile(
  guildId: string,
  filename: string,
): Promise<GuildSettings | null> {
  try {
    const dataDir = getDataDir();
    const path = join(dataDir, guildId, filename);
    console.log(`[loadGuildFile] Loading from: ${path}`);
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content);
    console.log(`[loadGuildFile] Loaded settings, has tokens array: ${Array.isArray((parsed as any).tokens)}, length: ${(parsed as any).tokens?.length || 0}`);
    return parsed;
  } catch (error) {
    console.error(`Error loading guild settings for guild ${guildId}:`, error);
    return null;
  }
}
export async function loadGuildSettings(guildId: string): Promise<GuildSettings | null> {
  return await loadGuildFile(guildId, "settings.json");
}

// File system helpers
async function getDataPath(guildId: string, filename: string): Promise<string> {
  const dataDir = getDataDir();
  const dirPath = `${dataDir}/${guildId}`;
  await ensureDir(dirPath);
  return `${dirPath}/${filename}`;
}

export async function saveGuildSettings(guildId: string, settings: GuildSettings): Promise<void> {
  const path = await getDataPath(guildId, "settings.json");
  await Deno.writeTextFile(path, JSON.stringify(settings, null, 2));
}

export async function loadRoles(guildId: string): Promise<RoleSetting[]> {
  return await loadGuildFile(guildId, "roles.json") as RoleSetting[] || [];
}

export async function saveRoles(guildId: string, roles: RoleSetting[]): Promise<void> {
  const path = await getDataPath(guildId, "roles.json");
  await Deno.writeTextFile(path, JSON.stringify(roles, null, 2));
}
