import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  GuildMember,
  Interaction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { loadGuildFile, loadGuildSettings } from "../lib/utils.ts";
import { GoogleCalendarClient } from "../lib/googlecalendar.ts";
import { getRoomEventsCache, invalidateRoomEventsCache, ensureRoomEventsCacheReady } from "../lib/room-events-cache.ts";
import { getUserEmail, saveUser, getUser } from "../lib/user-emails.ts";

import { mintTokens } from "../lib/blockchain.ts";
import { getAccountAddressForToken } from "../lib/citizenwallet.ts";

interface ShiftsSettings {
  calendarId: string;
  description: string;
  reward: string;
  rewardTokenSymbol: string;
  rewardAmountPerHour: number;
  maxSignupsPerSlot: number;
  shiftsMasterRoleId: string;
  slots: { start: string; end: string }[];
  timezone: string;
}

interface ShiftsState {
  step: string;
  guildId: string;
  selectedDate?: Date;
  selectedSlot?: { start: string; end: string };
  signupMode?: "standard" | "custom";
  email?: string;
  isShiftsMaster?: boolean;
  rewardSlotEvents?: any[];
  selectedRewardEvent?: any;
  rewardParticipants?: string[];
  rewardAmounts?: { [userId: string]: number };
  pastShiftParticipants?: ShiftSignup[];
}

interface ShiftSignup {
  discordUserId: string;
  username: string;
  email?: string;
}

interface CalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  start: { dateTime: string };
  end: { dateTime: string };
  attendees?: Array<{ email: string }>;
}

function invalidateShiftCaches() {
  // Also invalidate the room events cache since a signup happened
  invalidateRoomEventsCache();
}

async function getPastRewardableShiftEvents(calendarId: string): Promise<CalendarEvent[]> {
  const calendar = new GoogleCalendarClient();
  const now = new Date();
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  monthAgo.setHours(0, 0, 0, 0);

  try {
    const events = await calendar.listEvents(calendarId, monthAgo, now);
    return events
      .filter(event => parseShiftSignups(event.description || "").length > 0)
      .sort((a, b) => new Date(b.start.dateTime).getTime() - new Date(a.start.dateTime).getTime())
      .slice(0, 25);
  } catch (error) {
    console.error("Error fetching rewardable shifts:", error);
    return [];
  }
}



export const shiftsStates = new Map<string, ShiftsState>();

// Helper functions

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    month: "short", 
    day: "numeric"
  });
}

function formatTime(timeStr: string): string {
  const [hours, minutes] = timeStr.split(':');
  const hour = parseInt(hours);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${displayHour}:${minutes}${ampm}`;
}

function minutesToTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

function buildUpcomingDateOptions(days = 28): { label: string; value: string }[] {
  const cache = getRoomEventsCache();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const selectOptions: { label: string; value: string }[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const value = toDateValue(date);
    const count = cache.getEventCountForDate(date);
    const countText = count > 0 ? `${count} event${count > 1 ? 's' : ''}` : 'no events';

    let label: string;
    if (i === 0) label = `Today — ${countText}`;
    else if (i === 1) label = `Tomorrow — ${countText}`;
    else label = `${formatShortDate(date)} — ${countText}`;

    selectOptions.push({ label, value });
  }
  return selectOptions.slice(0, 25);
}

function getCustomStartOptions(): { label: string; value: string }[] {
  const options: { label: string; value: string }[] = [];
  for (let minutes = 8 * 60; minutes <= 22 * 60; minutes += 30) {
    const value = minutesToTime(minutes);
    options.push({
      label: formatTime(value),
      value,
    });
  }
  return options;
}

function getCustomDurationOptions(startTime: string): { label: string; value: string }[] {
  const startMinutes = timeToMinutes(startTime);
  const options: { label: string; value: string }[] = [];
  for (let duration = 1; duration <= 8; duration++) {
    const endMinutes = startMinutes + duration * 60;
    if (endMinutes < 24 * 60) {
      options.push({
        label: `${duration}h (${formatTime(startTime)} - ${formatTime(minutesToTime(endMinutes))})`,
        value: `${duration}`,
      });
    }
  }
  return options;
}

function formatEventTimeRange(event: CalendarEvent): string {
  const startTime = new Date(event.start.dateTime);
  const endTime = new Date(event.end.dateTime);
  return `${formatTime(startTime.toTimeString().substring(0,5))}-${formatTime(endTime.toTimeString().substring(0,5))}`;
}

function formatShiftOptionLabel(event: CalendarEvent): string {
  const startTime = new Date(event.start.dateTime);
  const dateStr = formatShortDate(startTime);
  const signups = parseShiftSignups(event.description || "");
  const signupsText = signups.length > 0 ? ` (${signups.map(s => s.username).join(", ")})` : "";
  return `${dateStr} ${formatEventTimeRange(event)}${signupsText}`.substring(0, 100);
}

// getDateOptions removed — replaced by dropdown with room event counts

function parseDateValue(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function toDateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getPastDateOptions(days = 30): { label: string; value: string }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const options: { label: string; value: string }[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    options.push({
      label: i === 0 ? "Today" : formatShortDate(date),
      value: toDateValue(date),
    });
  }
  return options.slice(0, 25);
}

function createDateTime(date: Date, timeStr: string, timezone: string): Date {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const dateTime = new Date(date);
  dateTime.setHours(hours, minutes, 0, 0);
  return dateTime;
}

function getSlotDurationHours(slot: { start: string; end: string }): number {
  return (timeToMinutes(slot.end) - timeToMinutes(slot.start)) / 60;
}

function formatAuditTimestamp(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function parseShiftSignups(description: string): ShiftSignup[] {
  const signups: ShiftSignup[] = [];
  const cancelled = new Set<string>();
  if (!description) return signups;
  
  for (const line of description.split('\n')) {
    // Format: "DisplayName <@username> signed up (discord:id)"
    const signup = line.match(/<@(\S+?)> signed up(?: \(discord:(\d+)\))?/);
    if (signup) {
      signups.push({ discordUserId: signup[2] || '', username: signup[1] });
      continue;
    }
    // Legacy: "@username signed up (discord:id)"
    const legacy = line.match(/@(\S+) signed up \(discord:(\d+)\)/);
    if (legacy) {
      signups.push({ discordUserId: legacy[2], username: legacy[1] });
      continue;
    }
    // Cancellation
    const cancel = line.match(/<@(\S+?)> cancelled/) || line.match(/@(\S+) cancelled/);
    if (cancel) cancelled.add(cancel[1]);
  }

  return signups.filter(s => !cancelled.has(s.username));
}

function appendToDescription(existingDescription: string, line: string): string {
  const trimmed = existingDescription.trimEnd();
  return trimmed ? `${trimmed}\n${line}` : line;
}

function getAuditNameForUser(guildId: string, userId: string, fallbackUsername: string): string {
  const user = getUser(guildId, userId);
  return user ? `${user.displayName} <@${user.username}>` : `<@${fallbackUsername}>`;
}

async function resolveShiftParticipants(
  interaction: ModalSubmitInteraction,
  guildId: string,
  rawInput: string,
): Promise<{ participants: ShiftSignup[]; unresolved: string[] }> {
  const guild = interaction.guild;
  if (!guild) {
    return { participants: [], unresolved: ["guild"] };
  }

  const tokens = new Set<string>();
  for (const match of rawInput.matchAll(/<@!?(\d+)>/g)) {
    tokens.add(match[1]);
  }

  const withoutMentions = rawInput.replace(/<@!?\d+>/g, " ");
  for (const part of withoutMentions.split(/[\s,;\n]+/)) {
    const token = part.trim().replace(/^@/, "");
    if (token) tokens.add(token);
  }

  const participants: ShiftSignup[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    let member: GuildMember | undefined;

    if (/^\d+$/.test(token)) {
      try {
        member = await guild.members.fetch(token);
      } catch {
        member = undefined;
      }
    } else {
      const normalized = token.toLowerCase();
      member = guild.members.cache.find(m =>
        m.user.username.toLowerCase() === normalized ||
        (m.displayName || "").toLowerCase() === normalized ||
        (m.user.globalName || "").toLowerCase() === normalized
      );

      if (!member) {
        try {
          const matches = await guild.members.fetch({ query: token, limit: 10 });
          member = matches.find(m =>
            m.user.username.toLowerCase() === normalized ||
            (m.displayName || "").toLowerCase() === normalized ||
            (m.user.globalName || "").toLowerCase() === normalized
          ) || matches.first();
        } catch {
          member = undefined;
        }
      }
    }

    if (!member || seen.has(member.id)) {
      if (!member) unresolved.push(token);
      continue;
    }

    seen.add(member.id);
    participants.push({
      discordUserId: member.id,
      username: member.user.username,
    });

    saveUser(guildId, {
      discordUserId: member.id,
      username: member.user.username,
      displayName: member.displayName || member.user.globalName || member.user.username,
      email: getUserEmail(guildId, member.id),
    }).catch(err => console.error("[shifts] Failed to save retroactive participant:", err));
  }

  return { participants, unresolved };
}



async function getShiftEvents(calendarId: string, date: Date): Promise<CalendarEvent[]> {
  const calendar = new GoogleCalendarClient();
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  try {
    return await calendar.listEvents(calendarId, startOfDay, endOfDay);
  } catch (error) {
    console.error("Error fetching shift events:", error);
    return [];
  }
}

async function getUserUpcomingShifts(calendarId: string, userId: string): Promise<CalendarEvent[]> {
  const calendar = new GoogleCalendarClient();
  const now = new Date();
  const nextWeek = new Date();
  nextWeek.setDate(now.getDate() + 7);
  
  try {
    const events = await calendar.listEvents(calendarId, now, nextWeek);
    return events.filter(event => {
      if (!event.description) return false;
      const signups = parseShiftSignups(event.description);
      return signups.some(signup => signup.discordUserId === userId);
    });
  } catch (error) {
    console.error("Error fetching user shifts:", error);
    return [];
  }
}

async function getAllUpcomingShifts(calendarId: string): Promise<CalendarEvent[]> {
  const calendar = new GoogleCalendarClient();
  const now = new Date();
  const nextWeek = new Date();
  nextWeek.setDate(now.getDate() + 7);
  
  try {
    return await calendar.listEvents(calendarId, now, nextWeek);
  } catch (error) {
    console.error("Error fetching all shifts:", error);
    return [];
  }
}

const CHT_MINTER_ROLE_ID = "1480923356013269044";

function isShiftsMaster(member: GuildMember, settings: ShiftsSettings): boolean {
  return member.roles.cache.has(settings.shiftsMasterRoleId) || member.roles.cache.has(CHT_MINTER_ROLE_ID);
}

// Update message helper
async function updateMessage(interaction: Interaction, data: { content: string; components: any[] }) {
  if ((interaction.isButton() || interaction.isStringSelectMenu()) && 'update' in interaction) {
    await interaction.update(data);
  } else if (interaction.isModalSubmit()) {
    await interaction.editReply(data);
  }
}

// Build the main shifts view content and components
async function buildMainView(userId: string, settings: ShiftsSettings, isMaster: boolean): Promise<{ content: string; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const userShifts = await getUserUpcomingShifts(settings.calendarId, userId);

  let content = `🔄 **Caretaking Shifts**\n\n`;
  content += `${settings.description}\n`;
  content += `💰 ${settings.reward}\n\n`;

  // Show user's upcoming shifts
  if (userShifts.length > 0) {
    content += `**Your upcoming shifts:**\n`;
    for (const shift of userShifts) {
      const startTime = new Date(shift.start.dateTime);
      const endTime = new Date(shift.end.dateTime);
      const dateStr = formatDate(startTime);
      const timeStr = `${formatTime(startTime.toTimeString().substring(0,5))} - ${formatTime(endTime.toTimeString().substring(0,5))}`;

      const signups = parseShiftSignups(shift.description || "");
      const otherSignups = signups.filter(s => s.discordUserId !== userId);
      const othersText = otherSignups.length > 0 ? ` (with ${otherSignups.map(s => s.username).join(", ")})` : "";

      content += `• ${dateStr} ${timeStr}${othersText}\n`;
    }
    content += `\n`;
  } else {
    content += `**Your upcoming shifts:** None\n\n`;
  }

  // Show all shifts for masters
  if (isMaster) {
    const allShifts = await getAllUpcomingShifts(settings.calendarId);
    if (allShifts.length > 0) {
      content += `**All upcoming shifts (next 7 days):**\n`;
      for (const shift of allShifts) {
        const startTime = new Date(shift.start.dateTime);
        const endTime = new Date(shift.end.dateTime);
        const dateStr = formatShortDate(startTime);
        const timeStr = `${formatTime(startTime.toTimeString().substring(0,5))}-${formatTime(endTime.toTimeString().substring(0,5))}`;

        const signups = parseShiftSignups(shift.description || "");
        const signupsText = signups.length > 0 ? ` (${signups.map(s => s.username).join(", ")})` : "";

        content += `• ${dateStr} ${timeStr}${signupsText}\n`;
      }
      content += `\n`;
    }
  }

  // Build buttons
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("shifts_signup")
      .setLabel("Sign up for a 3h shift")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("shifts_signup_custom")
      .setLabel("Sign up for a custom shift")
      .setStyle(ButtonStyle.Secondary),
  );

  if (userShifts.length > 0) {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId("shifts_cancel")
        .setLabel("Cancel a shift")
        .setStyle(ButtonStyle.Secondary),
    );
  }

  const components = [row1];

  if (isMaster) {
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("shifts_reward")
        .setLabel("Reward shifts")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("shifts_record_past")
        .setLabel("Record a past shift")
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(row2);
  }

  return { content, components };
}

// Main command handler
export async function handleShiftsCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  // Load shifts settings
  const settings = await loadGuildFile(guildId, "shifts-settings.json") as ShiftsSettings;
  if (!settings) {
    await interaction.reply({
      content: "⚠️ Shifts not configured for this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member as GuildMember;
  const isMaster = isShiftsMaster(member, settings);

  // Initialize state
  shiftsStates.set(userId, {
    step: "main",
    guildId,
    isShiftsMaster: isMaster
  });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { content, components } = await buildMainView(userId, settings, isMaster);

    await interaction.editReply({
      content,
      components,
    });

  } catch (error) {
    console.error("Error in shifts command:", error);
    await interaction.editReply({
      content: "⚠️ Error loading shifts data.",
    });
  }
}

// Button handler
export async function handleShiftsButton(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  const state = shiftsStates.get(userId);

  if (!state) {
    await interaction.update({
      content: "⚠️ Session expired. Please run /shifts again.",
      components: [],
    });
    return;
  }

  const settings = await loadGuildFile(guildId, "shifts-settings.json") as ShiftsSettings;
  if (!settings) {
    await interaction.update({
      content: "⚠️ Shifts settings not found.",
      components: [],
    });
    return;
  }

  // Sign up for shift
  if (customId === "shifts_signup") {
    state.step = "select_date";
    state.signupMode = "standard";
    shiftsStates.set(userId, state);

    // Ensure cache is initialized before reading (blocks only on first call)
    await ensureRoomEventsCacheReady();
    const selectOptions = buildUpcomingDateOptions();

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_signup_date_select")
      .setPlaceholder("Select a date for your 3h shift...")
      .addOptions(selectOptions);

    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("shifts_back_main")
        .setLabel("← Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("shifts_cancel_flow")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.update({
      content: "📅 **Select a date for your 3h shift:**",
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
        navRow,
      ],
    });
    return;
  }

  if (customId === "shifts_signup_custom") {
    state.step = "custom_select_date";
    state.signupMode = "custom";
    state.selectedSlot = undefined;
    shiftsStates.set(userId, state);

    await ensureRoomEventsCacheReady();
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_custom_date_select")
      .setPlaceholder("Select a date for your custom shift...")
      .addOptions(buildUpcomingDateOptions());

    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("shifts_back_main")
        .setLabel("← Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("shifts_cancel_flow")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.update({
      content: "📅 **Select a date for your custom shift:**",
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
        navRow,
      ],
    });
    return;
  }

  // Cancel a shift
  if (customId === "shifts_cancel") {
    const userShifts = await getUserUpcomingShifts(settings.calendarId, userId);
    
    if (userShifts.length === 0) {
      await interaction.update({
        content: "⚠️ You don't have any upcoming shifts to cancel.",
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("shifts_back_main")
              .setLabel("← Back")
              .setStyle(ButtonStyle.Secondary),
          )
        ],
      });
      return;
    }

    const options = userShifts.map((shift, index) => {
      const startTime = new Date(shift.start.dateTime);
      const endTime = new Date(shift.end.dateTime);
      const dateStr = formatShortDate(startTime);
      const timeStr = `${formatTime(startTime.toTimeString().substring(0,5))}-${formatTime(endTime.toTimeString().substring(0,5))}`;
      
      return {
        label: `${dateStr} ${timeStr}`,
        value: `cancel_${index}`,
        description: shift.summary || "Shift"
      };
    });

    state.step = "cancel_shift";
    state.rewardSlotEvents = userShifts; // Reuse this field for cancel shifts
    shiftsStates.set(userId, state);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_cancel_select")
      .setPlaceholder("Select a shift to cancel...")
      .addOptions(options);

    await interaction.update({
      content: "❌ **Select a shift to cancel:**",
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("shifts_back_main")
            .setLabel("← Back")
            .setStyle(ButtonStyle.Secondary),
        )
      ],
    });
    return;
  }

  // Reward shifts (masters only)
  if (customId === "shifts_reward") {
    if (!state.isShiftsMaster) {
      await interaction.update({
        content: "⚠️ You don't have permission to reward shifts.",
        components: [],
      });
      return;
    }

    state.step = "reward_select_shift";
    shiftsStates.set(userId, state);

    const rewardableShifts = await getPastRewardableShiftEvents(settings.calendarId);

    if (rewardableShifts.length === 0) {
      await interaction.update({
        content: "⚠️ No rewardable shifts found in the past month.",
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("shifts_back_main")
              .setLabel("← Back")
              .setStyle(ButtonStyle.Secondary),
          )
        ],
      });
      return;
    }

    state.rewardSlotEvents = rewardableShifts;
    shiftsStates.set(userId, state);

    const selectOptions = rewardableShifts.map((shift, index) => ({
      label: formatShiftOptionLabel(shift),
      value: `shift_${index}`,
      description: (shift.summary || "Shift").substring(0, 100),
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_reward_shift_select")
      .setPlaceholder("Select a shift to reward...")
      .addOptions(selectOptions);

    await interaction.update({
      content: "💰 **Select a shift to reward:**",
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("shifts_back_main")
            .setLabel("← Back")
            .setStyle(ButtonStyle.Secondary),
        )
      ],
    });
    return;
  }

  if (customId === "shifts_record_past") {
    if (!state.isShiftsMaster) {
      await interaction.update({
        content: "⚠️ You don't have permission to record past shifts.",
        components: [],
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId("shifts_past_participants_modal")
      .setTitle("Record a past shift")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("participants")
            .setLabel("Discord username(s) or mention(s)")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("@alice, @bob")
            .setRequired(true)
            .setMaxLength(500),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  // Date selection for signup
  if (customId.startsWith("shifts_date_")) {
    const dateValue = customId.replace("shifts_date_", "");
    const selectedDate = parseDateValue(dateValue);
    
    state.selectedDate = selectedDate;
    state.step = "select_slot";
    shiftsStates.set(userId, state);

    await showSlotSelection(interaction, userId, settings, selectedDate);
    return;
  }

  // Slot selection
  if (customId.startsWith("shifts_slot_")) {
    const slotIndex = parseInt(customId.replace("shifts_slot_", ""));
    const selectedSlot = settings.slots[slotIndex];
    
    state.selectedSlot = selectedSlot;
    state.step = "enter_email";
    shiftsStates.set(userId, state);

    const modal = new ModalBuilder()
      .setCustomId("shifts_email_modal")
      .setTitle("Email (Optional)")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("email")
            .setLabel("Enter your email if you want this to appear in your personal calendar (optional)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("your@email.com")
            .setRequired(false)
            .setMaxLength(100),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  // Add/change email for calendar invite
  if (customId === "shifts_add_email") {
    const modal = new ModalBuilder()
      .setCustomId("shifts_email_modal")
      .setTitle("Email for Calendar Invite")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("email")
            .setLabel("Email address (optional)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("your@email.com")
            .setRequired(false)
            .setMaxLength(100)
            .setValue(state.email || ""),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  // Confirm signup
  if (customId === "shifts_confirm_signup") {
    await processSignup(interaction, userId, guildId, settings, state);
    return;
  }

  // Confirm reward
  if (customId === "shifts_confirm_reward") {
    await processReward(interaction, userId, guildId, settings, state);
    return;
  }

  // Navigation buttons
  if (customId === "shifts_back_main") {
    // Re-initialize state for main view
    const member = interaction.member as GuildMember;
    const isMaster = isShiftsMaster(member, settings);
    shiftsStates.set(userId, {
      step: "main",
      guildId,
      isShiftsMaster: isMaster
    });

    try {
      const { content, components } = await buildMainView(userId, settings, isMaster);
      await interaction.update({ content, components });
    } catch (error) {
      console.error("Error returning to main view:", error);
      await interaction.update({
        content: "⚠️ Error loading shifts data.",
        components: [],
      });
    }
    return;
  }

  if (customId === "shifts_cancel_flow") {
    shiftsStates.delete(userId);
    await interaction.update({
      content: "❌ Cancelled.",
      components: [],
    });
    return;
  }
}

// String select handler
export async function handleShiftsSelect(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isStringSelectMenu()) return;

  const customId = interaction.customId;
  const state = shiftsStates.get(userId);

  if (!state) {
    await interaction.update({
      content: "⚠️ Session expired. Please run /shifts again.",
      components: [],
    });
    return;
  }

  const settings = await loadGuildFile(guildId, "shifts-settings.json") as ShiftsSettings;
  if (!settings) {
    await interaction.update({
      content: "⚠️ Shifts settings not found.",
      components: [],
    });
    return;
  }

  // Signup date selection (dropdown)
  if (customId === "shifts_signup_date_select") {
    const dateValue = interaction.values[0];
    const selectedDate = parseDateValue(dateValue);

    state.selectedDate = selectedDate;
    state.step = "select_slot";
    state.signupMode = "standard";
    shiftsStates.set(userId, state);

    await showSlotSelection(interaction, userId, settings, selectedDate);
    return;
  }

  if (customId === "shifts_custom_date_select") {
    const dateValue = interaction.values[0];
    state.selectedDate = parseDateValue(dateValue);
    state.step = "custom_select_start";
    state.signupMode = "custom";
    state.selectedSlot = undefined;
    shiftsStates.set(userId, state);

    const startOptions = getCustomStartOptions();
    const earlyOptions = startOptions.slice(0, 25);
    const lateOptions = startOptions.slice(25);
    const components: any[] = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("shifts_custom_start_select")
          .setPlaceholder("Select a start time...")
          .addOptions(earlyOptions),
      ),
    ];

    if (lateOptions.length > 0) {
      components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("shifts_custom_start_select_late")
            .setPlaceholder("Select a later start time...")
            .addOptions(lateOptions),
        ),
      );
    }

    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("shifts_signup_custom")
          .setLabel("← Back to date selection")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("shifts_cancel_flow")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      ),
    );

    await interaction.update({
      content: `🕐 **Select a start time for ${formatDate(state.selectedDate)}:**`,
      components,
    });
    return;
  }

  if (customId === "shifts_custom_start_select" || customId === "shifts_custom_start_select_late") {
    const startTime = interaction.values[0];
    state.selectedSlot = { start: startTime, end: startTime };
    state.step = "custom_select_duration";
    shiftsStates.set(userId, state);

    const durationOptions = getCustomDurationOptions(startTime);
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_custom_duration_select")
      .setPlaceholder("Select a duration...")
      .addOptions(durationOptions);

    await interaction.update({
      content: `⏱️ **Select a duration starting at ${formatTime(startTime)}:**`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("shifts_signup_custom")
            .setLabel("← Back to date selection")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("shifts_cancel_flow")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  if (customId === "shifts_custom_duration_select") {
    const durationHours = parseInt(interaction.values[0]);
    const startTime = state.selectedSlot!.start;
    const endTime = minutesToTime(timeToMinutes(startTime) + durationHours * 60);
    
    state.selectedSlot = { start: startTime, end: endTime };
    state.step = "confirm";
    state.signupMode = "custom";

    const savedEmail = getUserEmail(guildId, userId);
    if (savedEmail) state.email = savedEmail;

    shiftsStates.set(userId, state);

    await showSignupConfirmation(interaction, state, settings, guildId, userId);
    return;
  }

  // Slot selection (dropdown)
  if (customId === "shifts_slot_select") {
    const slotIndex = parseInt(interaction.values[0]);
    const selectedSlot = settings.slots[slotIndex];
    
    state.selectedSlot = selectedSlot;
    state.step = "confirm";
    state.signupMode = "standard";
    
    // Pre-fill email from saved user data
    const savedEmail = getUserEmail(guildId, userId);
    if (savedEmail) state.email = savedEmail;
    
    shiftsStates.set(userId, state);

    await showSignupConfirmation(interaction, state, settings, guildId, userId);
    return;
  }

  if (customId === "shifts_past_date_select") {
    const dateValue = interaction.values[0];
    state.selectedDate = parseDateValue(dateValue);
    state.step = "past_select_slot";
    shiftsStates.set(userId, state);

    const slotOptions = settings.slots.map((slot, index) => ({
      label: `${formatTime(slot.start)} - ${formatTime(slot.end)}`,
      value: `${index}`,
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_past_slot_select")
      .setPlaceholder("Select the shift time...")
      .addOptions(slotOptions.slice(0, 25));

    await interaction.update({
      content: `🕐 **Select the time for ${formatDate(state.selectedDate)}:**`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("shifts_record_past")
            .setLabel("← Back")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("shifts_cancel_flow")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  if (customId === "shifts_past_slot_select") {
    const slotIndex = parseInt(interaction.values[0]);
    state.selectedSlot = settings.slots[slotIndex];
    state.step = "past_record";
    shiftsStates.set(userId, state);

    await processPastShift(interaction, userId, guildId, settings, state);
    return;
  }

  // Cancel shift selection
  if (customId === "shifts_cancel_select") {
    const selectedIndex = parseInt(interaction.values[0].replace("cancel_", ""));
    const shiftToCancel = state.rewardSlotEvents![selectedIndex];

    await interaction.update({
      content: "⏳ Cancelling shift...",
      components: [],
    });

    try {
      await cancelShift(shiftToCancel, userId, guildId, settings);
      
      await interaction.editReply({
        content: "✅ Shift cancelled successfully.",
      });

      // Clear state
      shiftsStates.delete(userId);

    } catch (error) {
      console.error("Error cancelling shift:", error);
      await interaction.editReply({
        content: "❌ Error cancelling shift. Please try again.",
      });
    }
    return;
  }

  // Reward shift selection
  if (customId === "shifts_reward_shift_select") {
    const selectedIndex = parseInt(interaction.values[0].replace("shift_", ""));
    const selectedEvent = state.rewardSlotEvents![selectedIndex];
    
    state.selectedRewardEvent = selectedEvent;
    state.step = "reward_confirm";
    shiftsStates.set(userId, state);

    // Get declined attendee emails to filter them out
    const declinedEmails = new Set(
      (selectedEvent.attendees || [])
        .filter((a: any) => a.responseStatus === 'declined')
        .map((a: any) => a.email)
    );
    
    const allSignups = parseShiftSignups(selectedEvent.description || "");
    // Exclude users whose email has declined the calendar invite
    const signups = declinedEmails.size > 0
      ? allSignups.filter(s => {
          const userEmail = getUserEmail(interaction.guildId!, s.discordUserId);
          return !userEmail || !declinedEmails.has(userEmail);
        })
      : allSignups;
    
    if (signups.length === 0) {
      await interaction.update({
        content: "⚠️ No signups found for this shift.",
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("shifts_reward")
              .setLabel("← Back")
              .setStyle(ButtonStyle.Secondary),
          )
        ],
      });
      return;
    }

    // Calculate duration and reward
    const startTime = new Date(selectedEvent.start.dateTime);
    const endTime = new Date(selectedEvent.end.dateTime);
    const durationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);
    const rewardPerUser = durationHours * settings.rewardAmountPerHour;

    // Pre-fill reward amounts
    const rewardAmounts: { [userId: string]: number } = {};
    signups.forEach(signup => {
      rewardAmounts[signup.discordUserId] = rewardPerUser;
    });

    state.rewardParticipants = signups.map(s => s.discordUserId);
    state.rewardAmounts = rewardAmounts;
    shiftsStates.set(userId, state);

    let content = `💰 **Confirm shift rewards**\n\n`;
    content += `**Shift:** ${formatDate(startTime)} ${formatTime(startTime.toTimeString().substring(0,5))}-${formatTime(endTime.toTimeString().substring(0,5))}\n`;
    content += `**Duration:** ${durationHours}h\n`;
    content += `**Rate:** ${settings.rewardAmountPerHour} ${settings.rewardTokenSymbol}/hour\n\n`;
    content += `**Participants:**\n`;
    
    for (const signup of signups) {
      content += `• @${signup.username}: ${rewardPerUser} ${settings.rewardTokenSymbol}\n`;
    }
    
    const declinedSignups = allSignups.filter(s => !signups.some(active => active.discordUserId === s.discordUserId));
    if (declinedSignups.length > 0) {
      content += `\n**Excluded (declined):**\n`;
      for (const s of declinedSignups) {
        content += `• ~@${s.username}~\n`;
      }
    }

    await interaction.update({
      content,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("shifts_confirm_reward")
            .setLabel(`Mint ${rewardPerUser} ${settings.rewardTokenSymbol} each`)
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("shifts_reward")
            .setLabel("← Back")
            .setStyle(ButtonStyle.Secondary),
        )
      ],
    });
    return;
  }
}

// Modal handler
export async function handleShiftsModal(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isModalSubmit()) return;

  const customId = interaction.customId;
  const state = shiftsStates.get(userId);

  if (!state) {
    await interaction.reply({
      content: "⚠️ Session expired. Please run /shifts again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const settings = await loadGuildFile(guildId, "shifts-settings.json") as ShiftsSettings;
  if (!settings) {
    await interaction.reply({
      content: "⚠️ Shifts settings not found.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (customId === "shifts_email_modal") {
    const email = interaction.fields.getTextInputValue("email").trim();
    
    state.email = email || undefined;
    state.step = "confirm";
    shiftsStates.set(userId, state);

    // Save user info
    if (email) {
      await saveUser(guildId, {
        discordUserId: userId,
        username: interaction.user.username,
        displayName: interaction.user.displayName || interaction.user.globalName || interaction.user.username,
        email,
      });
    }

    await interaction.deferUpdate();
    const { content, components } = buildSignupConfirmation(state, settings);
    await interaction.editReply({ content, components });
    return;
  }

  if (customId === "shifts_past_participants_modal") {
    if (!state.isShiftsMaster) {
      await interaction.reply({
        content: "⚠️ You don't have permission to record past shifts.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const rawParticipants = interaction.fields.getTextInputValue("participants").trim();
    const { participants, unresolved } = await resolveShiftParticipants(interaction, guildId, rawParticipants);

    if (participants.length === 0 || unresolved.length > 0) {
      const unresolvedText = unresolved.length > 0 ? `\n\nCould not resolve: ${unresolved.map(u => `\`${u}\``).join(", ")}` : "";
      await interaction.reply({
        content: `⚠️ I could not resolve all participants. Use Discord mentions, user IDs, or exact usernames.${unresolvedText}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    state.pastShiftParticipants = participants;
    state.step = "past_select_date";
    shiftsStates.set(userId, state);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_past_date_select")
      .setPlaceholder("Select the shift date...")
      .addOptions(getPastDateOptions());

    await interaction.reply({
      content: `📅 **Select the shift date for:** ${participants.map(p => `@${p.username}`).join(", ")}`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("shifts_cancel_flow")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }
}

// Deferred version — used after deferUpdate() when coming from select menu
async function showSlotSelectionDeferred(interaction: Interaction, userId: string, settings: ShiftsSettings, date: Date) {
  try {
    const { content, components } = await buildSlotSelectionData(settings, date);
    if ('editReply' in interaction) {
      await (interaction as any).editReply({ content, components });
    }
  } catch (error) {
    console.error("Error showing slot selection (deferred):", error);
    if ('editReply' in interaction) {
      await (interaction as any).editReply({
        content: "⚠️ Error loading shift slots.",
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("shifts_back_main")
              .setLabel("← Back")
              .setStyle(ButtonStyle.Secondary),
          )
        ],
      });
    }
  }
}

// Build signup confirmation view
function buildSignupConfirmation(state: ShiftsState, settings: ShiftsSettings): { content: string; components: any[] } {
  const selectedDate = state.selectedDate!;
  const selectedSlot = state.selectedSlot!;
  const durationHours = getSlotDurationHours(selectedSlot);

  let content = `📋 **Confirm your shift signup**\n\n`;
  content += `**Date:** ${formatDate(selectedDate)}\n`;
  content += `**Time:** ${formatTime(selectedSlot.start)} - ${formatTime(selectedSlot.end)}\n`;
  content += `**Reward:** ${durationHours * settings.rewardAmountPerHour} ${settings.rewardTokenSymbol}\n`;
  if (state.email) {
    content += `**Email:** ${state.email} _(calendar invite will be sent)_\n`;
  } else {
    content += `\n📧 _Provide your email address to receive a calendar invitation._\n`;
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId("shifts_confirm_signup")
      .setLabel("✅ Confirm signup")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("shifts_add_email")
      .setLabel(state.email ? "✏️ Change email" : "📧 Add email")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(state.signupMode === "custom" ? "shifts_signup_custom" : "shifts_signup")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
  ];

  return {
    content,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
  };
}

// Show signup confirmation (used from select menu and button handlers)
async function showSignupConfirmation(
  interaction: Interaction,
  state: ShiftsState,
  settings: ShiftsSettings,
  guildId: string,
  userId: string,
) {
  const { content, components } = buildSignupConfirmation(state, settings);
  await updateMessage(interaction, { content, components });
}

// Build slot selection data (shared by immediate and deferred versions)
async function buildSlotSelectionData(settings: ShiftsSettings, date: Date): Promise<{ content: string; components: any[] }> {
  const shiftEvents = await getShiftEvents(settings.calendarId, date);
  const cache = getRoomEventsCache();
  
  // Collect all room events for this day
  const allDayRoomEvents: { start: string; end: string; title: string; room: string }[] = [];
  for (const slot of settings.slots) {
    const slotRoomEvents = cache.getEventsForSlot(date, slot.start, slot.end);
    for (const e of slotRoomEvents) {
      // Dedupe by title+room (events can span multiple slots)
      if (!allDayRoomEvents.some(x => x.title === e.title && x.room === e.room)) {
        const eventStart = new Date(e.start);
        const eventEnd = new Date(e.end);
        allDayRoomEvents.push({
          start: eventStart.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: settings.timezone }).replace(':00', ''),
          end: eventEnd.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: settings.timezone }).replace(':00', ''),
          title: e.title,
          room: e.room,
        });
      }
    }
  }

  let content = `🕐 **Shifts for ${formatDate(date)}**\n\n`;
  
  if (allDayRoomEvents.length > 0) {
    for (const e of allDayRoomEvents) {
      content += `${e.start}-${e.end}: ${e.title} (${e.room})\n`;
    }
  } else {
    content += `No booking that day (yet)\n`;
  }
  content += `\n`;
  
  const selectOptions: { label: string; value: string; description?: string }[] = [];
  
  for (let i = 0; i < settings.slots.length; i++) {
    const slot = settings.slots[i];
    
    const slotStart = createDateTime(date, slot.start, settings.timezone);
    const slotEnd = createDateTime(date, slot.end, settings.timezone);
    
    const existingEvent = shiftEvents.find(event => {
      const eventStart = new Date(event.start.dateTime);
      const eventEnd = new Date(event.end.dateTime);
      return Math.abs(eventStart.getTime() - slotStart.getTime()) < 60000 && 
             Math.abs(eventEnd.getTime() - slotEnd.getTime()) < 60000;
    });
    
    const signups = existingEvent ? parseShiftSignups(existingEvent.description || "") : [];
    const spotsLeft = settings.maxSignupsPerSlot - signups.length;
    const isFull = spotsLeft <= 0;
    
    let label = `${formatTime(slot.start)} - ${formatTime(slot.end)}`;
    let description = '';
    
    if (isFull) {
      label = `🔴 ${label} (full)`;
    } else if (signups.length > 0) {
      label = `🟡 ${label} (${spotsLeft}/${settings.maxSignupsPerSlot} spots)`;
      description = `with ${signups.map(s => s.username).join(", ")}`;
    } else {
      label = `🟢 ${label} (${settings.maxSignupsPerSlot} spots)`;
    }
    
    if (!isFull) {
      selectOptions.push({
        label: label.substring(0, 100),
        value: `${i}`,
        description: description ? description.substring(0, 100) : undefined,
      });
    }
  }

  const components: any[] = [];

  if (selectOptions.length > 0) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_slot_select")
      .setPlaceholder("Select a shift")
      .addOptions(selectOptions.slice(0, 25));
    
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
  } else {
    content += "⚠️ All slots are full for this date.\n";
  }

  // Navigation
  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("shifts_signup")
      .setLabel("← Back to date selection")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("shifts_cancel_flow")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );
  components.push(navRow);
  
  return { content, components };
}

// Helper functions for slot selection
async function showSlotSelection(interaction: Interaction, userId: string, settings: ShiftsSettings, date: Date) {
  try {
    const { content, components } = await buildSlotSelectionData(settings, date);
    await updateMessage(interaction, { content, components });
  } catch (error) {
    console.error("Error showing slot selection:", error);
    await updateMessage(interaction, {
      content: "⚠️ Error loading shift slots.",
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("shifts_back_main")
            .setLabel("← Back")
            .setStyle(ButtonStyle.Secondary),
        )
      ],
    });
  }
}

// Process signup
async function processSignup(interaction: ButtonInteraction, userId: string, guildId: string, settings: ShiftsSettings, state: ShiftsState) {
  await interaction.update({
    content: "⏳ Creating your shift signup...",
    components: [],
  });

  try {
    const calendar = new GoogleCalendarClient();
    // Use impersonation when adding attendees (requires Domain-Wide Delegation)
    const calendarWithInvites = state.email
      ? new GoogleCalendarClient({ impersonateUser: Deno.env.get("GOOGLE_CALENDAR_IMPERSONATE_USER") || undefined })
      : calendar;
    const selectedDate = state.selectedDate!;
    const selectedSlot = state.selectedSlot!;
    
    const startDateTime = createDateTime(selectedDate, selectedSlot.start, settings.timezone);
    const endDateTime = createDateTime(selectedDate, selectedSlot.end, settings.timezone);
    
    // Check if event already exists
    const existingEvents = await getShiftEvents(settings.calendarId, selectedDate);
    const existingEvent = existingEvents.find(event => {
      const eventStart = new Date(event.start.dateTime);
      const eventEnd = new Date(event.end.dateTime);
      return Math.abs(eventStart.getTime() - startDateTime.getTime()) < 60000 && 
             Math.abs(eventEnd.getTime() - endDateTime.getTime()) < 60000;
    });

    const displayName = interaction.user.displayName || interaction.user.globalName || interaction.user.username;
    const auditName = `${displayName} <@${interaction.user.username}>`;
    
    // Save/update user info on every signup
    saveUser(interaction.guildId!, {
      discordUserId: userId,
      username: interaction.user.username,
      displayName,
      email: state.email,
    }).catch(err => console.error("[shifts] Failed to save user:", err));
    
    const newSignup: ShiftSignup = {
      discordUserId: userId,
      username: interaction.user.username,
      email: state.email
    };

    if (existingEvent) {
      // Update existing event
      const existingSignups = parseShiftSignups(existingEvent.description || "");
      
      // Check if user already signed up
      if (existingSignups.some(s => s.discordUserId === userId)) {
        await interaction.editReply({
          content: "⚠️ You're already signed up for this shift.",
        });
        return;
      }
      
      // Check capacity
      if (existingSignups.length >= settings.maxSignupsPerSlot) {
        await interaction.editReply({
          content: "⚠️ This shift is full.",
        });
        return;
      }
      
      // Append signup (single audit line, never overwrite existing description)
      let desc = existingEvent.description || "";
      desc = appendToDescription(desc, `${formatAuditTimestamp()}: ${auditName} signed up (discord:${userId})`);
      
      const updateData: any = { description: desc };
      if (state.email) {
        updateData.attendees = [...(existingEvent.attendees || []), { email: state.email }];
      }
      await calendarWithInvites.updateEvent(settings.calendarId, existingEvent.id!, updateData);
      
    } else {
      // Create new event
      const eventTitle = `Shift: ${formatTime(selectedSlot.start)}-${formatTime(selectedSlot.end)}`;
      const description = `${formatAuditTimestamp()}: ${auditName} signed up (discord:${userId})`;
      
      const calendarEvent: any = {
        summary: eventTitle,
        description,
        location: "Commons Hub Brussels, Rue de la Madeleine 51, 1000 Brussels",
        start: {
          dateTime: startDateTime.toISOString(),
          timeZone: settings.timezone,
        },
        end: {
          dateTime: endDateTime.toISOString(), 
          timeZone: settings.timezone,
        },
      };
      
      if (state.email) {
        calendarEvent.attendees = [{ email: state.email }];
      }
      
      await calendarWithInvites.createEventNoConflictCheck(settings.calendarId, calendarEvent);
    }

    // Invalidate caches after signup
    invalidateShiftCaches();

    await interaction.editReply({
      content: `✅ **Shift signup confirmed!**

**Date:** ${formatDate(selectedDate)}
**Time:** ${formatTime(selectedSlot.start)} - ${formatTime(selectedSlot.end)}
**Reward:** ${getSlotDurationHours(selectedSlot) * settings.rewardAmountPerHour} ${settings.rewardTokenSymbol}

Your shift has been added to the calendar. Thank you for helping take care of our space! 🙏`,
    });

    shiftsStates.delete(userId);

  } catch (error: any) {
    console.error("Error processing signup:", error);
    const errorMsg = error?.message || error?.errors?.[0]?.message || String(error);
    await interaction.editReply({
      content: `❌ Error creating shift signup: ${errorMsg}`,
    });
  }
}

// Cancel shift
async function cancelShift(shiftEvent: CalendarEvent, userId: string, guildId: string, settings: ShiftsSettings) {
  const calendar = new GoogleCalendarClient();
  
  const signups = parseShiftSignups(shiftEvent.description || "");
  const userSignup = signups.find(s => s.discordUserId === userId);
  
  if (!userSignup) {
    throw new Error("You're not signed up for this shift");
  }
  
  // Build human-readable name for audit trail
  const user = getUser(guildId, userId);
  const auditName = user ? `${user.displayName} <@${user.username}>` : `<@${userSignup.username}>`;
  
  // Append cancellation (single audit line)
  let desc = shiftEvent.description || "";
  desc = appendToDescription(desc, `${formatAuditTimestamp()}: ${auditName} cancelled`);
  
  const remainingSignups = signups.filter(s => s.discordUserId !== userId);
  
  if (remainingSignups.length === 0) {
    // No one left — update description but keep the event (preserves history)
    await calendar.updateEvent(settings.calendarId, shiftEvent.id!, {
      description: desc,
      summary: `[Cancelled] ${shiftEvent.summary || 'Shift'}`,
    });
  } else {
    await calendar.updateEvent(settings.calendarId, shiftEvent.id!, {
      description: desc,
    });
  }
}

async function buildRewardResultContent(
  guildId: string,
  minterUserId: string,
  minterUsername: string,
  settings: ShiftsSettings,
  state: ShiftsState,
): Promise<string> {
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    throw new Error("Guild settings not found");
  }

  const token = guildSettings.tokens.find(t => t.symbol === settings.rewardTokenSymbol);
  if (!token) {
    throw new Error(`Token ${settings.rewardTokenSymbol} not configured`);
  }

  const signups = parseShiftSignups(state.selectedRewardEvent!.description || "");
  const results: { userId: string; username: string; amount: number; success: boolean; hash?: string; error?: string }[] = [];

  for (const participantUserId of state.rewardParticipants!) {
    const signup = signups.find(s => s.discordUserId === participantUserId);

    try {
      const amount = state.rewardAmounts![participantUserId];
      const recipientAddress = await getAccountAddressForToken(participantUserId, token);
      
      if (!recipientAddress) {
        throw new Error("No wallet address found");
      }

      const hash = await mintTokens(
        token.chain as any,
        token.address,
        recipientAddress,
        amount.toString(),
        token.decimals,
      );

      results.push({
        userId: participantUserId,
        username: signup?.username || "Unknown",
        amount,
        success: true,
        hash: hash ?? undefined
      });

    } catch (error) {
      results.push({
        userId: participantUserId,
        username: signup?.username || "Unknown",
        amount: state.rewardAmounts![participantUserId],
        success: false,
        error: String(error)
      });
    }
  }

  const successfulRewards = results.filter(r => r.success);
  if (successfulRewards.length > 0) {
    const calendar = new GoogleCalendarClient();
    let desc = state.selectedRewardEvent!.description || "";
    
    const ts = formatAuditTimestamp();
    const minterName = getAuditNameForUser(guildId, minterUserId, minterUsername);
    for (const result of successfulRewards) {
      const recipientUser = getUser(guildId, result.userId);
      const recipientName = recipientUser ? `${recipientUser.displayName} <@${recipientUser.username}>` : `<@${result.username}>`;
      desc = appendToDescription(desc, `${ts}: ${minterName} minted ${result.amount} ${settings.rewardTokenSymbol} for ${recipientName} (tx: ${result.hash})`);
    }
    
    await calendar.updateEvent(settings.calendarId, state.selectedRewardEvent!.id!, {
      description: desc
    });
  }

  let content = `💰 **Shift rewards processed**\n\n`;
  
  const successCount = successfulRewards.length;
  const failCount = results.length - successCount;
  
  if (successCount > 0) {
    content += `**✅ Successful rewards (${successCount}):**\n`;
    for (const result of successfulRewards) {
      const txUrl = `https://txinfo.xyz/${token.chain}/tx/${result.hash}`;
      content += `• @${result.username}: ${result.amount} ${settings.rewardTokenSymbol} [[tx]](<${txUrl}>)\n`;
    }
    content += `\n`;
  }
  
  if (failCount > 0) {
    content += `**❌ Failed rewards (${failCount}):**\n`;
    const failedResults = results.filter(r => !r.success);
    for (const result of failedResults) {
      content += `• @${result.username}: ${result.amount} ${settings.rewardTokenSymbol} (${result.error})\n`;
    }
  }

  return content;
}

async function processPastShift(
  interaction: StringSelectMenuInteraction,
  userId: string,
  guildId: string,
  settings: ShiftsSettings,
  state: ShiftsState,
) {
  await interaction.update({
    content: "⏳ Recording past shift and processing rewards...",
    components: [],
  });

  try {
    const calendar = new GoogleCalendarClient();
    const selectedDate = state.selectedDate!;
    const selectedSlot = state.selectedSlot!;
    const participants = state.pastShiftParticipants || [];
    const startDateTime = createDateTime(selectedDate, selectedSlot.start, settings.timezone);
    const endDateTime = createDateTime(selectedDate, selectedSlot.end, settings.timezone);

    const existingEvents = await getShiftEvents(settings.calendarId, selectedDate);
    const existingEvent = existingEvents.find(event => {
      const eventStart = new Date(event.start.dateTime);
      const eventEnd = new Date(event.end.dateTime);
      return Math.abs(eventStart.getTime() - startDateTime.getTime()) < 60000 && 
             Math.abs(eventEnd.getTime() - endDateTime.getTime()) < 60000;
    });

    const recorderName = getAuditNameForUser(guildId, userId, interaction.user.username);
    let desc = existingEvent?.description || "";
    const existingSignups = parseShiftSignups(desc);

    for (const participant of participants) {
      if (existingSignups.some(s => s.discordUserId === participant.discordUserId)) {
        continue;
      }
      const participantUser = getUser(guildId, participant.discordUserId);
      const participantName = participantUser ? `${participantUser.displayName} <@${participantUser.username}>` : `<@${participant.username}>`;
      desc = appendToDescription(desc, `${formatAuditTimestamp()}: ${participantName} signed up (discord:${participant.discordUserId}) retroactively by ${recorderName}`);
    }

    let shiftEvent: CalendarEvent;
    if (existingEvent) {
      shiftEvent = {
        ...existingEvent,
        description: desc,
      };
      await calendar.updateEvent(settings.calendarId, existingEvent.id!, { description: desc });
    } else {
      const eventTitle = `Shift: ${formatTime(selectedSlot.start)}-${formatTime(selectedSlot.end)}`;
      shiftEvent = await calendar.createEventNoConflictCheck(settings.calendarId, {
        summary: eventTitle,
        description: desc,
        location: "Commons Hub Brussels, Rue de la Madeleine 51, 1000 Brussels",
        start: {
          dateTime: startDateTime.toISOString(),
          timeZone: settings.timezone,
        },
        end: {
          dateTime: endDateTime.toISOString(),
          timeZone: settings.timezone,
        },
      });
    }

    const durationHours = (endDateTime.getTime() - startDateTime.getTime()) / (1000 * 60 * 60);
    const rewardPerUser = durationHours * settings.rewardAmountPerHour;
    const rewardAmounts: { [participantUserId: string]: number } = {};
    for (const participant of participants) {
      rewardAmounts[participant.discordUserId] = rewardPerUser;
    }

    state.selectedRewardEvent = shiftEvent;
    state.rewardParticipants = participants.map(p => p.discordUserId);
    state.rewardAmounts = rewardAmounts;

    const rewardContent = await buildRewardResultContent(guildId, userId, interaction.user.username, settings, state);
    await interaction.editReply({
      content: `✅ **Past shift recorded**\n\n${rewardContent}`,
    });

    invalidateShiftCaches();
    shiftsStates.delete(userId);
  } catch (error) {
    console.error("Error recording past shift:", error);
    await interaction.editReply({
      content: "❌ Error recording past shift. Please try again.",
    });
  }
}

// Process reward
async function processReward(interaction: ButtonInteraction, userId: string, guildId: string, settings: ShiftsSettings, state: ShiftsState) {
  await interaction.update({
    content: "⏳ Processing rewards...",
    components: [],
  });

  try {
    const content = await buildRewardResultContent(guildId, userId, interaction.user.username, settings, state);
    await interaction.editReply({ content });
    shiftsStates.delete(userId);
  } catch (error) {
    console.error("Error processing rewards:", error);
    await interaction.editReply({
      content: "❌ Error processing rewards. Please try again.",
    });
  }
}
