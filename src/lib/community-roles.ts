/**
 * Community roles, as attested on Nostr (kind 31926 `role` tags) and used for permissions:
 * - steward: any Discord role whose name contains "steward" (case-insensitive), e.g. "Plant steward".
 *   Stewards may change transaction categories (chb trusts their category annotations).
 * - member: the guild's member role (members-only requests, e.g. asking Elinor for tokens).
 */
import type { GuildMember } from "discord.js";

/** The member role per guild. Guilds not listed have no member restriction. */
export const MEMBER_ROLE_BY_GUILD: Record<string, string> = {
  "1280532848604086365": "1280559675292778617", // Commons Hub Brussels
};

type RoleHolder = Pick<GuildMember, "roles">;

/** Xavier's rule (Oct 2026): a role whose name contains "steward", anywhere, any case. Nothing else. */
export function isSteward(member: RoleHolder): boolean {
  return member.roles.cache.some((r) => /steward/i.test(r.name));
}

export function hasMemberRole(member: RoleHolder, guildId: string): boolean {
  const role = MEMBER_ROLE_BY_GUILD[guildId];
  return !!role && member.roles.cache.has(role);
}

/** The roles to attest for this member: exactly these (attestations are a complete list). */
export function communityRoles(member: RoleHolder, guildId: string): string[] {
  return [...(hasMemberRole(member, guildId) ? ["member"] : []), ...(isSteward(member) ? ["steward"] : [])];
}
