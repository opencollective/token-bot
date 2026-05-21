import { GuildMember, Interaction, MessageFlags, PermissionsBitField } from "discord.js";
import { disabledCalendars } from "../lib/calendar-state.ts";
import { buildUserPermissionReport, formatUserPermissionReport } from "../lib/permissions.ts";
import { loadGuildFile, loadGuildSettings } from "../lib/utils.ts";
import type { Product } from "../types.ts";

export default async function handlePermissionsCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "❌ Could not access server." });
    return;
  }

  const targetUser = interaction.options.getUser("user") || interaction.user;
  const member = await guild.members.fetch(targetUser.id).catch(() => null) as GuildMember | null;
  if (!member) {
    await interaction.editReply({ content: "❌ Could not find that server member." });
    return;
  }

  const guildSettings = await loadGuildSettings(guildId);
  const products = await loadGuildFile(guildId, "products.json").catch(() => []) as Product[];
  const shiftsSettings = await loadGuildFile(guildId, "shifts-settings.json").catch(() => null) as
    | { calendarId?: string; shiftsMasterRoleId?: string }
    | null;

  const report = buildUserPermissionReport({
    userId: targetUser.id,
    isAdministrator: member.permissions.has(PermissionsBitField.Flags.Administrator),
    roleIds: [...member.roles.cache.keys()],
    guildSettings,
    products,
    shiftsSettings,
    disabledCalendarIds: disabledCalendars,
  });

  await interaction.editReply({
    content: formatUserPermissionReport(report),
  });
}
