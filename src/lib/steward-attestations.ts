/**
 * Keep the bot's member-key attestations (kind 31926) in line with Discord roles, so chb trusts
 * stewards' category changes and stops trusting people who are no longer stewards:
 * - every steward (a role whose name contains "steward") gets an attestation with role steward
 *   (and member, when they have the member role);
 * - members the bot attested before are republished with their current roles (a lost steward role
 *   is revoked, since the newest attestation per key and d wins).
 * Runs at startup, daily, and when a member's roles change.
 */
import type { Client, Guild, GuildMember, PartialGuildMember } from "discord.js";
import { loadGuildFile } from "./utils.ts";
import { KIND_ATTESTATION, ShiftsNostr, type ShiftsNostrSettings } from "./shifts-nostr.ts";
import { communityRoles, isSteward } from "./community-roles.ts";

async function nostrFor(guild: Guild): Promise<ShiftsNostr | null> {
  const settings = await loadGuildFile(guild.id, "shifts-settings.json").catch(() => null) as { nostr?: ShiftsNostrSettings } | null;
  return ShiftsNostr.forGuild({ guildId: guild.id, name: guild.name }, settings?.nostr);
}

function asDiscordMember(m: GuildMember, guildId: string) {
  return {
    id: m.id,
    username: m.user.username,
    displayName: m.displayName || m.user.globalName || m.user.username,
    avatar: m.displayAvatarURL({ size: 256, extension: "png" }),
    roles: communityRoles(m, guildId),
  };
}

/** Discord ids the bot has attested in this guild's relays. */
async function attestedIds(sn: ShiftsNostr): Promise<Set<string>> {
  const events = await sn.query({ kinds: [KIND_ATTESTATION], authors: [sn.botPubkey] });
  return new Set(events.map((e) => e.tags.find((t) => t[0] === "d")?.[1]).filter((d): d is string => !!d?.startsWith("discord:")).map((d) => d.slice(8)));
}

export async function syncStewardAttestations(guild: Guild): Promise<{ stewards: number; updated: number; failed: number }> {
  const sn = await nostrFor(guild);
  if (!sn) return { stewards: 0, updated: 0, failed: 0 };
  const [members, attested] = await Promise.all([guild.members.fetch(), attestedIds(sn)]);
  let stewards = 0, updated = 0, failed = 0;
  for (const m of members.values()) {
    if (m.user.bot) continue;
    const steward = isSteward(m);
    if (steward) stewards++;
    if (!steward && !attested.has(m.id)) continue;
    try {
      await sn.ensureMemberIdentity(asDiscordMember(m, guild.id));
      updated++;
    } catch (error) {
      failed++;
      console.error(`[stewards] attestation for ${m.user.username} failed:`, (error as Error).message);
    }
  }
  return { stewards, updated, failed };
}

export async function syncAllStewardAttestations(client: Client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const r = await syncStewardAttestations(guild);
      if (r.stewards || r.updated) console.log(`[stewards] ${guild.name}: ${r.stewards} stewards, ${r.updated} attestations checked, ${r.failed} failed`);
    } catch (error) {
      console.error(`[stewards] sync failed for ${guild.name}:`, error);
    }
  }
}

/** When someone's roles change, update their attestation if they're (or were) a steward. */
export async function onMemberRolesChanged(before: GuildMember | PartialGuildMember, after: GuildMember) {
  const was = before.partial ? null : isSteward(before as GuildMember);
  const is = isSteward(after);
  if (was === is || (was === null && !is)) return;
  const sn = await nostrFor(after.guild);
  if (!sn) return;
  try {
    await sn.ensureMemberIdentity(asDiscordMember(after, after.guild.id));
    console.log(`[stewards] ${after.user.username} ${is ? "is now" : "is no longer"} a steward: attestation updated`);
  } catch (error) {
    console.error(`[stewards] attestation update for ${after.user.username} failed:`, (error as Error).message);
  }
}
