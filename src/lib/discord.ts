import {
  Client,
  Collection,
  GatewayIntentBits,
  GuildMember,
  Message,
  PermissionsBitField,
  TextChannel,
} from "discord.js";

export type DiscordRoleSettings = {
  id: string;
  name: string;
  burnAmount?: number;
  mintAmount?: number;
  frequency: string;
  gracePeriod?: number;
  ignoreUsers?: string[];
  notifications?: string[];
};

function isDisabled(): boolean {
  const denoTest = Deno.env.get("DENO_TEST") === "true";
  const env = Deno.env.get("ENV") || Deno.env.get("DENO_ENV");
  const DRY_RUN = Deno.env.get("DRY_RUN") || Deno.env.get("DRYRUN");
  if (denoTest || env === "test" || env === "dryrun" || DRY_RUN) return true;
  return false;
}

/**
 * Discord client
 * @usage import { Discord } from "./discord.ts";
 * @usage const discord = Discord.getInstance();
 * @usage if (discord) {
 * @usage   discord.postToDiscordChannel("Hello, world!");
 * @usage   const messages = await discord.fetchLatestMessagesFromChannel("1234567890", "1234567890", 10);
 * @usage   const message = await discord.fetchLatestMessageFromChannel("1234567890");
 * @usage   await discord.removeMessagesFromChannel("1234567890", ["1234567890"]);
 * @usage   const reply = await discord.replyToMessage("1234567890", "1234567890", "Hello, world!");
 * @usage   const members = await discord.getMembers("1234567890");
 * @usage   await discord.removeRole(guild, member, "1234567890");
 * @usage   await discord.close();
 * @usage }
 */
export class Discord {
  private static instance: Discord | null = null;

  private client: Client | null = null;
  private readyPromise: Promise<void> | null = null;
  private destroyed = false;

  private constructor(
    private discordBotToken?: string,
    private guildId?: string,
    private defaultChannelId?: string,
  ) {}

  static getInstance(): Discord | null {
    if (this.instance) return this.instance;

    const discordBotToken = Deno.env.get("DISCORD_BOT_TOKEN");
    const guildId = Deno.env.get("DISCORD_GUILD_ID") || undefined;
    const channelId = Deno.env.get("DISCORD_CHANNEL_ID") || undefined;

    // If no discordBotToken, consider it disabled (return null) to avoid side effects in test/dev
    if (!discordBotToken) return null;

    this.instance = new Discord(discordBotToken, guildId, channelId);
    return this.instance;
  }

  private ensureClient(): void {
    if (this.client || !this.discordBotToken) return;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
      ],
    });

    this.client.on("error", (error) => {
      if (this.destroyed) return;
      console.error("Discord client error:", error);
    });

    this.client.on("disconnect", () => {
      if (this.destroyed) return;
      console.log("Discord client disconnected");
    });

    this.readyPromise = new Promise<void>((resolve) => {
      this.client!.once("clientReady", () => {
        console.log(`Discord bot logged in as ${this.client!.user?.tag}`);
        resolve();
      });
    });

    this.client.login(this.discordBotToken!).catch((e) => {
      console.error("Discord login failed:", e);
    });
  }

  private async ensureReady(): Promise<void> {
    this.ensureClient();
    if (!this.client || !this.readyPromise) return;
    await this.readyPromise;
  }

  async close(): Promise<void> {
    this.destroyed = true;
    if (this.client) {
      try {
        const maybe = this.client.destroy() as unknown;
        if (maybe && typeof (maybe as Promise<void>).then === "function") {
          await (maybe as Promise<void>);
        }
      } catch {
        // ignore
      }
      this.client.removeAllListeners();
      this.client = null;
      this.readyPromise = null;
    }
  }

  async postToDiscordChannel(message: string, channelId?: string) {
    if (isDisabled()) {
      console.log(
        `\nDRYRUN/DISABLED: Would have posted to Discord:\n${message}\n`,
      );
      return;
    }
    await this.ensureReady();
    if (!this.client) return;

    const id = channelId || this.defaultChannelId;
    if (!id) throw new Error("DISCORD_CHANNEL_ID is not set");

    const channel = await this.client.channels.fetch(id);
    if (!channel || !(channel instanceof TextChannel)) {
      throw new Error("Channel not found or is not a text channel");
    }
    if ((Deno.env.get("ENV") || "") === "dryrun") {
      console.log(`\nDRYRUN: Would have posted to Discord:\n${message}\n`);
      return;
    }
    await channel.send(message);
  }

  async fetchLatestMessagesFromChannel(
    channelId: string,
    sinceMessageId?: string,
    limit: number = 10,
  ): Promise<Message[]> {
    if (isDisabled()) return [];
    await this.ensureReady();
    if (!this.client) return [];

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      throw new Error("Channel not found or is not a text channel");
    }

    const results: Message[] = [];

    if (sinceMessageId) {
      let lastId = sinceMessageId;
      while (results.length < limit) {
        const batchSize = Math.min(100, limit - results.length);
        const batch = await channel.messages.fetch({
          after: lastId,
          limit: batchSize,
        });
        if (batch.size === 0) break;
        const arr = Array.from(batch.values()).sort(
          (a, b) => a.createdTimestamp - b.createdTimestamp,
        );
        results.push(...arr);
        lastId = arr[arr.length - 1].id;
        if (batch.size < batchSize) break;
      }
      return results
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .slice(0, limit);
    } else {
      let before: string | undefined = undefined;
      while (results.length < limit) {
        const batchSize = Math.min(100, limit - results.length);
        const batch = (await channel.messages.fetch(
          before ? { before, limit: batchSize } : { limit: batchSize },
        )) as Collection<string, Message<true>>;
        if (batch.size === 0) break;
        const arr = Array.from(batch.values());
        results.push(...arr);
        before = arr[arr.length - 1].id;
        if (batch.size < batchSize) break;
      }
      return results
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .slice(0, limit);
    }
  }

  async fetchLatestMessageFromChannel(
    channelId: string,
  ): Promise<Message | null> {
    const messages = await this.fetchLatestMessagesFromChannel(
      channelId,
      undefined,
      1,
    );
    return messages[0] || null;
  }

  async removeMessagesFromChannel(channelId: string, messageIds: string[]) {
    if (isDisabled()) return;
    await this.ensureReady();
    if (!this.client) return;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      throw new Error("Channel not found or is not a text channel");
    }
    await channel.bulkDelete(messageIds);
  }

  async replyToMessage(
    channelId: string,
    messageId: string,
    replyContent: string,
  ): Promise<Message> {
    if (isDisabled()) return {} as Message;
    await this.ensureReady();
    if (!this.client) return {} as Message;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      throw new Error("Channel not found or is not a text channel");
    }
    if ((Deno.env.get("ENV") || "") === "dryrun") {
      console.log(
        `\nDRYRUN: Would have replied to message ${messageId}:\n${replyContent}\n`,
      );
      return {} as Message;
    }
    const message = await channel.messages.fetch(messageId);
    const reply = await message.reply(replyContent);
    return reply;
  }

  async getMembers(roleId: string): Promise<GuildMember[]> {
    await this.ensureReady();
    if (!this.client) {
      console.log("❌ Discord client is not ready.");
      return [];
    }

    const guildId = this.guildId;
    if (!guildId) {
      console.log("❌ Guild ID is not set.");
      return [];
    }

    const guild = await this.client.guilds.fetch(guildId);
    const members = await guild.members.fetch();
    if (!members) return [];
    const users = members.filter((member) => member.roles.cache.has(roleId));
    return Array.from(users.values());
  }

  async removeRole(userId: string, roleId: string) {
    await this.ensureReady();
    if (!this.client) {
      console.log("❌ Discord client is not ready.");
      return [];
    }
    const guildId = this.guildId;
    if (!guildId) {
      console.log("❌ Guild ID is not set.");
      return [];
    }
    const guild = await this.client.guilds.fetch(guildId);
    const botMember = guild.members.me;
    if (!botMember) {
      console.log("❌ Bot is not a member of this guild.");
      return;
    }
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      console.log("❌ Bot lacks 'Manage Roles' permission.");
      console.log(
        "🔧 Solution: Grant 'Manage Roles' to the bot in the server settings.",
      );
      return;
    }
    const roleToRemove = guild.roles.cache.get(roleId);
    if (!roleToRemove) {
      console.log(`❌ Role with ID '${roleId}' not found in guild.`);
      return;
    }
    if (roleToRemove.position >= botMember.roles.highest.position) {
      console.log(
        `❌ The role '${roleToRemove.name}' is higher or equal to the bot's highest role.`,
      );
      console.log(
        "🔧 Solution: Move the bot's role higher than the role you're trying to remove.",
      );
      return;
    }
    const targetMember = await guild.members.fetch(userId) as GuildMember;
    if (!targetMember) {
      console.log(`❌ Target member '${userId}' not found.`);
      return;
    }
    if (
      targetMember.roles.highest.position >= botMember.roles.highest.position &&
      targetMember.id !== botMember.id
    ) {
      console.log(
        `❌ Target member '${targetMember.user.tag}' has a role higher or equal to the bot's highest role.`,
      );
      console.log(
        "🔧 Solution: The bot cannot modify members with higher/equal roles. Move the bot role higher.",
      );
      return;
    }
    if (!targetMember.roles.cache.has(roleToRemove.id)) {
      console.log(
        `⚠️ Target member does not have the role '${roleToRemove.name}'. Nothing to remove.`,
      );
      return;
    }
    try {
      await targetMember.roles.remove(roleToRemove);
      console.log(
        `✅ Successfully removed role '${roleToRemove.name}' from '${targetMember.user.tag}'.`,
      );
    } catch (err) {
      console.error("❌ Failed to remove role:", err);
    }
  }
}

// Backwards-compatible wrappers for existing imports
export const postToDiscordChannel = async (message: string) =>
  await Discord.getInstance()?.postToDiscordChannel(message);

export async function fetchLatestMessagesFromChannel(
  channelId: string,
  sinceMessageId?: string,
  limit: number = 10,
): Promise<Message[]> {
  return (
    (await Discord.getInstance()?.fetchLatestMessagesFromChannel(
      channelId,
      sinceMessageId,
      limit,
    )) || []
  );
}

export async function fetchLatestMessageFromChannel(
  channelId: string,
): Promise<Message | null> {
  return (
    (await Discord.getInstance()?.fetchLatestMessageFromChannel(channelId)) ||
    null
  );
}

export async function removeMessagesFromChannel(
  channelId: string,
  messageIds: string[],
) {
  await Discord.getInstance()?.removeMessagesFromChannel(channelId, messageIds);
}

export async function replyToMessage(
  channelId: string,
  messageId: string,
  replyContent: string,
): Promise<Message> {
  return (await Discord.getInstance()?.replyToMessage(
    channelId,
    messageId,
    replyContent,
  )) as Message;
}

export const getMembers = async (roleId: string): Promise<GuildMember[]> =>
  (await Discord.getInstance()?.getMembers(roleId)) || [];

export default {
  Discord,
  postToDiscordChannel,
  fetchLatestMessagesFromChannel,
  fetchLatestMessageFromChannel,
  removeMessagesFromChannel,
  replyToMessage,
  getMembers,
};
