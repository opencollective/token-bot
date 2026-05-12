/**
 * User store — persisted as users.jsonl per guild in DATA_DIR.
 * Loaded into memory at startup, updated on write.
 * 
 * Format (one JSON object per line):
 *   {"discordUserId":"123","username":"xdamman","displayName":"Xavier Damman","email":"x@example.com","updatedAt":"..."}
 */

import { getEnv } from "./utils.ts";

export interface UserEntry {
  discordUserId: string;
  username: string;
  displayName: string;
  email?: string;
  updatedAt: string;
}

// In-memory store: guildId -> (discordUserId -> UserEntry)
const usersByGuild = new Map<string, Map<string, UserEntry>>();

export async function initUserEmails(): Promise<void> {
  const dataDir = getEnv("DATA_DIR") || "/data";
  try {
    for await (const entry of Deno.readDir(dataDir)) {
      if (!entry.isDirectory) continue;
      const guildId = entry.name;
      const filePath = `${dataDir}/${guildId}/users.jsonl`;
      try {
        const content = await Deno.readTextFile(filePath);
        const guildUsers = new Map<string, UserEntry>();
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            // Support old format (just email) and new format (full entry)
            const entry: UserEntry = {
              discordUserId: parsed.discordUserId,
              username: parsed.username || "",
              displayName: parsed.displayName || "",
              email: parsed.email,
              updatedAt: parsed.updatedAt,
            };
            guildUsers.set(entry.discordUserId, entry);
          } catch { /* skip malformed */ }
        }
        usersByGuild.set(guildId, guildUsers);
        console.log(`[users] Loaded ${guildUsers.size} users for guild ${guildId}`);
      } catch { /* no file yet */ }
    }
  } catch { /* DATA_DIR doesn't exist */ }
}

export function getUser(guildId: string, discordUserId: string): UserEntry | undefined {
  return usersByGuild.get(guildId)?.get(discordUserId);
}

export function getUserEmail(guildId: string, discordUserId: string): string | undefined {
  return usersByGuild.get(guildId)?.get(discordUserId)?.email;
}

export function getUserByEmail(guildId: string, email: string): UserEntry | undefined {
  const guildUsers = usersByGuild.get(guildId);
  if (!guildUsers) return undefined;
  for (const user of guildUsers.values()) {
    if (user.email === email) return user;
  }
  return undefined;
}

/**
 * Save/update user info. Always updates all fields.
 */
export async function saveUser(guildId: string, user: { discordUserId: string; username: string; displayName: string; email?: string }): Promise<void> {
  let guildUsers = usersByGuild.get(guildId);
  if (!guildUsers) {
    guildUsers = new Map();
    usersByGuild.set(guildId, guildUsers);
  }

  const entry: UserEntry = {
    ...user,
    updatedAt: new Date().toISOString(),
  };
  guildUsers.set(user.discordUserId, entry);

  const dataDir = getEnv("DATA_DIR") || "/data";
  const dirPath = `${dataDir}/${guildId}`;
  const filePath = `${dirPath}/users.jsonl`;
  
  try {
    await Deno.mkdir(dirPath, { recursive: true });
    await Deno.writeTextFile(filePath, JSON.stringify(entry) + "\n", { append: true });
  } catch (error) {
    console.error(`[users] Failed to save user ${user.discordUserId}:`, error);
  }
}

// Backwards compat alias
export const setUserEmail = async (guildId: string, discordUserId: string, email: string): Promise<void> => {
  const existing = getUser(guildId, discordUserId);
  await saveUser(guildId, {
    discordUserId,
    username: existing?.username || "",
    displayName: existing?.displayName || "",
    email,
  });
};
