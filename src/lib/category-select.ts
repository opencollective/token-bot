/**
 * The category dropdown on transaction reports: stewards pick a category, the bot publishes the
 * change signed by that steward's key, and edits the report ("set by @x").
 */
import { GuildMember, MessageFlags, StringSelectMenuInteraction, TextChannel } from "discord.js";
import { loadGuildSettings } from "./utils.ts";
import { setTransactionCategory } from "./category-annotations.ts";
import { communityRoles, isSteward } from "./community-roles.ts";
import { categoryLine, categoryMenu, findCategory, parseCategorySelectId, replaceCategoryLine, txHashesIn, txUriFor } from "./tx-categories.ts";
import { findReportByMessage, REPORT_SELECT_ID, updateReportCategory } from "./tx-reports.ts";

export const ONLY_STEWARDS = "Only stewards can change the category.";

/** Stewards: a Discord role whose name contains "steward" (see community-roles.ts). */
export function stewardCheck(member: GuildMember, _guildId?: string): Promise<boolean> {
  return Promise.resolve(isSteward(member));
}

export async function logCategoryChange(client: StringSelectMenuInteraction["client"], guildId: string, text: string) {
  try {
    const settings = await loadGuildSettings(guildId);
    const channelId = settings?.channels?.logs;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased() && "send" in channel) await (channel as TextChannel).send({ content: text, allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("[category] could not log:", error);
  }
}

/** The transactions and currency behind a report's dropdown: from the report store, or (older reports) from the customId and links. */
async function reportOf(interaction: StringSelectMenuInteraction, guildId: string): Promise<{ uris: string[]; currency: string; legacy: string | null } | null> {
  if (interaction.customId === REPORT_SELECT_ID) {
    const r = await findReportByMessage(guildId, interaction.message.id);
    return r ? { uris: r.uris, currency: r.currency, legacy: null } : null;
  }
  const parsed = parseCategorySelectId(interaction.customId);
  if (!parsed) return null;
  const hashes = txHashesIn(interaction.message.content);
  return hashes.length ? { uris: hashes.map((h) => txUriFor(parsed.chain, h)), currency: parsed.tokenSymbol, legacy: interaction.customId } : null;
}

export async function handleCategorySelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  const member = interaction.member instanceof GuildMember
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !(await stewardCheck(member, guildId))) {
    await interaction.reply({ content: ONLY_STEWARDS, flags: MessageFlags.Ephemeral });
    return;
  }

  const report = await reportOf(interaction, guildId);
  if (!report) {
    await interaction.reply({ content: "I can't find the transactions behind this report.", flags: MessageFlags.Ephemeral });
    return;
  }
  const category = findCategory(report.currency, interaction.values[0] ?? "");
  if (!category) {
    await interaction.reply({ content: `Unknown category "${interaction.values[0]}".`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  try {
    const { changes, npub } = await setTransactionCategory({
      guildId,
      guildName: interaction.guild.name,
      member: {
        id: member.id,
        username: member.user.username,
        displayName: member.displayName || member.user.username,
        avatar: member.displayAvatarURL({ size: 256, extension: "png" }),
        roles: communityRoles(member, guildId),
      },
      uris: report.uris,
      category: category.slug,
    });
    await interaction.editReply({
      content: replaceCategoryLine(interaction.message.content, categoryLine(category.slug, report.currency, member.id)),
      components: [categoryMenu(report.legacy ?? REPORT_SELECT_ID, report.currency, category.slug)],
      allowedMentions: { parse: [] },
    });
    if (!report.legacy) await updateReportCategory(guildId, interaction.message.id, category.slug, member.id);
    const was = [...new Set(changes.map((c) => c.previous ?? "uncategorized"))].join("/");
    await logCategoryChange(
      interaction.client,
      guildId,
      `🏷️ <@${member.id}> changed the category of ${changes.length} ${report.currency} transaction${changes.length > 1 ? "s" : ""} from ${was} to ${category.slug} (${interaction.message.url}), signed by ${npub}`,
    );
  } catch (error) {
    console.error("[category] change failed:", error);
    await interaction.followUp({
      content: `❌ Couldn't change the category: ${error instanceof Error ? error.message : String(error)}`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}
