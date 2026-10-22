/**
 * /guestpass [length] [start] [guest_name] [guest_email]: a member buys a door link for a guest
 * with their own tokens (src/lib/guest-pass.ts).
 *
 * Shows the price and the details with Confirm and Cancel (ephemeral: only the member sees it);
 * Confirm burns the price and shows the door link, also sent to them by DM so they keep it.
 * A second click finds no intent, so it charges once.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import { loadGuildSettings } from "../lib/utils.ts";
import { checkBalance, shopToken, tokens } from "../lib/shop.ts";
import { executeGuestPass, guestLabel, guestPassItem, type GuestPassLength, linkMessage, normalizeEmail, parseStart, passWindow, whenLabel } from "../lib/guest-pass.ts";
import { MEMBER_ROLE_BY_GUILD } from "../lib/community-roles.ts";
import { getUserEmail } from "../lib/user-emails.ts";
import { txUrlFor } from "../lib/mint.ts";
import { clip } from "../lib/discord-text.ts";
import { COWORKING_TOKEN_TERMS } from "../lib/token-terms.ts";

export const GUESTPASS_PREFIX = "gpass:";
const INTENT_TTL_MS = 15 * 60 * 1000;

type Intent = {
  userId: string;
  guildId: string;
  length: GuestPassLength;
  /** ISO, or null for "when they confirm". */
  start: string | null;
  guestName?: string;
  guestEmail?: string;
  at: number;
};
const intents = new Map<string, Intent>();

function newIntent(i: Omit<Intent, "at">): string {
  const now = Date.now();
  for (const [id, x] of intents) if (now - x.at > INTENT_TTL_MS) intents.delete(id);
  const id = crypto.randomUUID().slice(0, 8);
  intents.set(id, { ...i, at: now });
  return id;
}

/** Members only (the guild's member role, or an admin). Guilds without a member role: everyone. */
export function isGuildMember(m: Pick<GuildMember, "roles" | "permissions"> | null, guildId: string): boolean {
  const role = MEMBER_ROLE_BY_GUILD[guildId];
  if (!role) return true;
  return !!m && (m.roles.cache.has(role) || m.permissions.has(PermissionsBitField.Flags.Administrator));
}

const nameOf = (i: ChatInputCommandInteraction | ButtonInteraction) => {
  const m = i.member && "displayName" in i.member ? i.member : null;
  return m?.displayName || i.user.globalName || i.user.username;
};

export async function handleGuestPassCommand(interaction: ChatInputCommandInteraction, userId: string, guildId: string) {
  const member = interaction.member && "roles" in interaction.member && "permissions" in interaction.member && typeof interaction.member.permissions !== "string"
    ? interaction.member as GuildMember
    : null;
  if (!isGuildMember(member, guildId)) {
    await interaction.reply({ content: "Guest passes are for members.", flags: MessageFlags.Ephemeral });
    return;
  }
  const settings = await loadGuildSettings(guildId);
  const token = shopToken(settings);
  if (!token) {
    await interaction.reply({ content: "❌ No token to pay with is configured in this server.", flags: MessageFlags.Ephemeral });
    return;
  }
  const item = guestPassItem(interaction.options.getString("length"));
  if (!item) {
    await interaction.reply({ content: "❌ Choose a half day or a full day.", flags: MessageFlags.Ephemeral });
    return;
  }
  const startInput = interaction.options.getString("start");
  const parsed = parseStart(startInput);
  if ("error" in parsed) {
    await interaction.reply({ content: `❌ ${parsed.error}`, flags: MessageFlags.Ephemeral });
    return;
  }
  const guestEmail = normalizeEmail(interaction.options.getString("guest_email"));
  if (guestEmail === null) {
    await interaction.reply({ content: "❌ That guest email doesn't look valid.", flags: MessageFlags.Ephemeral });
    return;
  }
  const guestName = interaction.options.getString("guest_name")?.trim() || undefined;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const check = await checkBalance(userId, token, item);
  const { start, end } = passWindow(parsed.start, item);
  const lines = [
    `🎟️ **${item.label}** for **${guestLabel(nameOf(interaction), guestName)}**: ${tokens(item.price)}`,
    `🕘 ${whenLabel(start, end)} (the door link works only then)`,
    guestEmail ? `📨 We'll email your guest the link and how to get in.` : `🔗 You get the door link to share with your guest.`,
    `Your balance: **${tokens(check.balance)}**`,
    `-# ${COWORKING_TOKEN_TERMS}`,
  ];
  if (!check.ok) {
    lines.push("", `❌ ${check.message}`);
    await interaction.editReply({ content: clip(lines.join("\n")) });
    return;
  }
  lines.push("", `-# The price is burned from your account when you confirm.`);
  const id = newIntent({ userId, guildId, length: item.length, start: startInput?.trim() ? parsed.start.toISOString() : null, guestName, guestEmail });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${GUESTPASS_PREFIX}${id}:confirm`).setLabel(`Confirm and pay ${tokens(item.price)}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${GUESTPASS_PREFIX}${id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ content: clip(lines.join("\n")), components: [row] });
}

export async function handleGuestPassButton(interaction: ButtonInteraction) {
  const [id, action] = interaction.customId.slice(GUESTPASS_PREFIX.length).split(":");
  const intent = intents.get(id);
  if (!intent || Date.now() - intent.at > INTENT_TTL_MS) {
    await interaction.update({ content: "⌛ This expired. Run /guestpass again. Nothing was charged.", components: [] });
    return;
  }
  if (interaction.user.id !== intent.userId) {
    await interaction.reply({ content: "This isn't yours.", flags: MessageFlags.Ephemeral });
    return;
  }
  // One click only: the second click on the same message finds no intent.
  intents.delete(id);
  if (action !== "confirm") {
    await interaction.update({ content: "Cancelled. Nothing was charged.", components: [] });
    return;
  }
  const settings = await loadGuildSettings(intent.guildId);
  const token = shopToken(settings);
  const item = guestPassItem(intent.length)!;
  if (!settings || !token) {
    await interaction.update({ content: "❌ Guest passes are not available right now. Nothing was charged.", components: [] });
    return;
  }
  const start = intent.start ? new Date(intent.start) : new Date();
  if (start.getTime() < Date.now() - 15 * 60000) {
    await interaction.update({ content: "⌛ The start time has passed. Run /guestpass again. Nothing was charged.", components: [] });
    return;
  }
  await interaction.update({ content: `⏳ Buying a ${item.label.toLowerCase()} for ${tokens(item.price)}…`, components: [] });

  const buyerName = nameOf(interaction);
  const result = await executeGuestPass({
    client: interaction.client,
    guildId: intent.guildId,
    guildSettings: settings,
    token,
    item,
    buyer: { id: interaction.user.id, name: buyerName, email: getUserEmail(intent.guildId, interaction.user.id) },
    guestName: intent.guestName,
    guestEmail: intent.guestEmail,
    start,
    via: "command",
  });
  if (!result.ok) {
    await interaction.editReply({ content: clip(`❌ ${result.error}\nNothing was charged.`) });
    return;
  }
  const message = linkMessage(result, item);
  const paid = `✅ Paid ${tokens(item.price)}. New balance: ${tokens(result.balanceAfter)}. [View transaction](<${txUrlFor(token, result.hash)}>)\n-# ${COWORKING_TOKEN_TERMS}`;
  await interaction.editReply({ content: clip(`${message}\n\n${paid}`) }).catch((e) => console.error("[guestpass] could not show the link:", e));
  // A copy by DM: the ephemeral message disappears.
  await interaction.user.send({ content: clip(message) }).catch(() => {});
}
