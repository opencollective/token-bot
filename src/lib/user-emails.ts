/**
 * User email store — persisted as users.jsonl per guild in DATA_DIR.
 * Loaded into memory at startup, updated on write.
 * 
 * Format (one JSON object per line):
 *   {"discordUserId":"123","email":"user@example.com","updatedAt":"2026-03-18T10:00:00Z"}
 */

import { getEnv } from "./utils.ts";

interface UserEmailEntry {
  discordUserId: string;
  email: string;
  updatedAt: string;
}

// In-memory store: guildId -> (discordUserId -> email)
const emailsByGuild = new Map<string, Map<string, string>>();

/**
 * Load all users.jsonl files from DATA_DIR at startup.
 */
export async function initUserEmails(): Promise<void> {
  const dataDir = getEnv("DATA_DIR") || "./data";
  try {
    for await (const entry of Deno.readDir(dataDir)) {
      if (!entry.isDirectory) continue;
      const guildId = entry.name;
      const filePath = `${dataDir}/${guildId}/users.jsonl`;
      try {
        const content = await Deno.readTextFile(filePath);
        const guildEmails = new Map<string, string>();
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as UserEmailEntry;
            guildEmails.set(entry.discordUserId, entry.email);
          } catch {
            // Skip malformed lines
          }
        }
        emailsByGuild.set(guildId, guildEmails);
        console.log(`[user-emails] Loaded ${guildEmails.size} emails for guild ${guildId}`);
      } catch {
        // No users.jsonl yet — that's fine
      }
    }
  } catch {
    // DATA_DIR doesn't exist yet
  }
}

/**
 * Get a user's saved email for a guild.
 */
export function getUserEmail(guildId: string, discordUserId: string): string | undefined {
  return emailsByGuild.get(guildId)?.get(discordUserId);
}

/**
 * Save a user's email. Updates memory + appends to users.jsonl.
 */
export async function setUserEmail(guildId: string, discordUserId: string, email: string): Promise<void> {
  // Update memory
  let guildEmails = emailsByGuild.get(guildId);
  if (!guildEmails) {
    guildEmails = new Map();
    emailsByGuild.set(guildId, guildEmails);
  }
  guildEmails.set(discordUserId, email);

  // Append to file
  const dataDir = getEnv("DATA_DIR") || "./data";
  const dirPath = `${dataDir}/${guildId}`;
  const filePath = `${dirPath}/users.jsonl`;
  
  try {
    await Deno.mkdir(dirPath, { recursive: true });
    const entry: UserEmailEntry = {
      discordUserId,
      email,
      updatedAt: new Date().toISOString(),
    };
    await Deno.writeTextFile(filePath, JSON.stringify(entry) + "\n", { append: true });
  } catch (error) {
    console.error(`[user-emails] Failed to save email for ${discordUserId}:`, error);
  }
}
