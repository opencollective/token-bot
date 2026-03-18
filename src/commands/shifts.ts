import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  GuildMember,
  Interaction,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { loadGuildFile, loadGuildSettings } from "../lib/utils.ts";
import { GoogleCalendarClient } from "../lib/googlecalendar.ts";
import { getRoomEventsCache, invalidateRoomEventsCache, ensureRoomEventsCacheReady } from "../lib/room-events-cache.ts";
import { getUserEmail, setUserEmail } from "../lib/user-emails.ts";

import { mintTokens } from "../lib/blockchain.ts";
import { getAccountAddressForToken } from "../lib/citizenwallet.ts";
import { formatUnits } from "@wevm/viem";

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
  email?: string;
  isShiftsMaster?: boolean;
  rewardDate?: Date;
  rewardSlotEvents?: any[];
  selectedRewardEvent?: any;
  rewardParticipants?: string[];
  rewardAmounts?: { [userId: string]: number };
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

// Shift dates cache (for reward flow — past dates with shifts)
const shiftDatesCache = new Map<string, { data: { label: string; value: string }[]; timestamp: number }>();
const SHIFT_CACHE_TTL_MS = 5 * 60 * 1000;

function invalidateShiftCaches() {
  shiftDatesCache.clear();
  // Also invalidate the room events cache since a signup happened
  invalidateRoomEventsCache();
}

async function getPastDatesWithShifts(calendarId: string): Promise<{ label: string; value: string }[]> {
  const cacheKey = calendarId;
  const cached = shiftDatesCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SHIFT_CACHE_TTL_MS) {
    return cached.data;
  }

  const calendar = new GoogleCalendarClient();
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  monthAgo.setHours(0, 0, 0, 0);

  try {
    const events = await calendar.listEvents(calendarId, monthAgo, today);
    const datesWithShifts = new Map<string, Date>();

    for (const event of events) {
      const eventDate = new Date(event.start.dateTime);
      const dateValue = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}-${String(eventDate.getDate()).padStart(2, '0')}`;
      if (!datesWithShifts.has(dateValue)) {
        const d = new Date(eventDate);
        d.setHours(0, 0, 0, 0);
        datesWithShifts.set(dateValue, d);
      }
    }

    // Sort descending (most recent first)
    const sorted = Array.from(datesWithShifts.entries())
      .sort((a, b) => b[1].getTime() - a[1].getTime())
      .slice(0, 25);

    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);

    const options = sorted.map(([value, date]) => {
      const isToday = date.getTime() === todayDate.getTime();
      return {
        label: isToday ? "Today" : formatShortDate(date),
        value,
      };
    });

    shiftDatesCache.set(cacheKey, { data: options, timestamp: Date.now() });
    return options;
  } catch (error) {
    console.error("Error fetching past shift dates:", error);
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

// getDateOptions removed — replaced by dropdown with room event counts

// getPastDateOptions removed — replaced by getPastDatesWithShifts()

function parseDateValue(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function createDateTime(date: Date, timeStr: string, timezone: string): Date {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const dateTime = new Date(date);
  dateTime.setHours(hours, minutes, 0, 0);
  return dateTime;
}

function parseShiftSignups(description: string): ShiftSignup[] {
  const signups: ShiftSignup[] = [];
  if (!description) return signups;
  
  const lines = description.split('\n');
  for (const line of lines) {
    const match = line.match(/^signup:\s*discord:(\d+):([^:]+)(?::(.+))?$/);
    if (match) {
      signups.push({
        discordUserId: match[1],
        username: match[2],
        email: match[3] || undefined
      });
    }
  }
  return signups;
}

function updateEventDescription(existingDescription: string = "", newSignup: ShiftSignup): string {
  const lines = existingDescription.split('\n').filter(line => !line.startsWith('signup:'));
  lines.push(`signup: discord:${newSignup.discordUserId}:${newSignup.username}${newSignup.email ? ':' + newSignup.email : ''}`);
  return lines.join('\n');
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

function isShiftsMaster(member: GuildMember, settings: ShiftsSettings): boolean {
  return member.roles.cache.has(settings.shiftsMasterRoleId);
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
      .setLabel("Sign up for a shift")
      .setStyle(ButtonStyle.Primary),
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
    shiftsStates.set(userId, state);

    // Ensure cache is initialized before reading (blocks only on first call)
    await ensureRoomEventsCacheReady();
    const cache = getRoomEventsCache();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const selectOptions: { label: string; value: string }[] = [];
    for (let i = 0; i < 28; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const count = cache.getEventCountForDate(date);
      const countText = count > 0 ? `${count} event${count > 1 ? 's' : ''}` : 'no events';

      let label: string;
      if (i === 0) label = `Today — ${countText}`;
      else if (i === 1) label = `Tomorrow — ${countText}`;
      else label = `${formatShortDate(date)} — ${countText}`;

      selectOptions.push({ label, value });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_signup_date_select")
      .setPlaceholder("Select a date for your shift...")
      .addOptions(selectOptions.slice(0, 25));

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
      content: "📅 **Select a date for your shift:**",
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

    state.step = "reward_select_date";
    shiftsStates.set(userId, state);

    const selectOptions = await getPastDatesWithShifts(settings.calendarId);

    if (selectOptions.length === 0) {
      await interaction.update({
        content: "⚠️ No shifts found in the past month.",
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

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_reward_date_select")
      .setPlaceholder("Select a date to reward shifts...")
      .addOptions(selectOptions);

    await interaction.update({
      content: "💰 **Select a date to reward shifts:**",
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
    shiftsStates.set(userId, state);

    await showSlotSelection(interaction, userId, settings, selectedDate);
    return;
  }

  // Slot selection (dropdown)
  if (customId === "shifts_slot_select") {
    const slotIndex = parseInt(interaction.values[0]);
    const selectedSlot = settings.slots[slotIndex];
    
    state.selectedSlot = selectedSlot;
    state.step = "confirm";
    
    // Pre-fill email from saved user data
    const savedEmail = getUserEmail(guildId, userId);
    if (savedEmail) state.email = savedEmail;
    
    shiftsStates.set(userId, state);

    await showSignupConfirmation(interaction, state, settings, guildId, userId);
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
      await cancelShift(shiftToCancel, userId, settings);
      
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

  // Reward date selection
  if (customId === "shifts_reward_date_select") {
    const dateValue = interaction.values[0];
    const selectedDate = parseDateValue(dateValue);
    
    state.rewardDate = selectedDate;
    state.step = "reward_select_shift";
    shiftsStates.set(userId, state);

    // Get shifts for the selected date
    const shiftEvents = await getShiftEvents(settings.calendarId, selectedDate);
    
    if (shiftEvents.length === 0) {
      await interaction.update({
        content: `⚠️ No shifts found for ${formatDate(selectedDate)}.`,
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

    const shiftOptions = shiftEvents.map((shift, index) => {
      const startTime = new Date(shift.start.dateTime);
      const endTime = new Date(shift.end.dateTime);
      const timeStr = `${formatTime(startTime.toTimeString().substring(0,5))}-${formatTime(endTime.toTimeString().substring(0,5))}`;
      
      const signups = parseShiftSignups(shift.description || "");
      const signupsText = signups.length > 0 ? ` (${signups.map(s => s.username).join(", ")})` : " (no signups)";
      
      return {
        label: timeStr + signupsText,
        value: `shift_${index}`,
        description: shift.summary || "Shift"
      };
    });

    state.rewardSlotEvents = shiftEvents;
    shiftsStates.set(userId, state);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_reward_shift_select")
      .setPlaceholder("Select a shift to reward...")
      .addOptions(shiftOptions);

    await interaction.update({
      content: `💰 **Select a shift to reward for ${formatDate(selectedDate)}:**`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
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

  // Reward shift selection
  if (customId === "shifts_reward_shift_select") {
    const selectedIndex = parseInt(interaction.values[0].replace("shift_", ""));
    const selectedEvent = state.rewardSlotEvents![selectedIndex];
    
    state.selectedRewardEvent = selectedEvent;
    state.step = "reward_confirm";
    shiftsStates.set(userId, state);

    const signups = parseShiftSignups(selectedEvent.description || "");
    
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

    // Save email for future use
    if (email) {
      await setUserEmail(guildId, userId, email);
    }

    await interaction.deferUpdate();
    const { content, components } = buildSignupConfirmation(state, settings);
    await interaction.editReply({ content, components });
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
  const durationHours = parseInt(selectedSlot.end.split(':')[0]) - parseInt(selectedSlot.start.split(':')[0]);

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
      .setCustomId("shifts_signup")
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
  
  let content = `🕐 **Select a time slot for ${formatDate(date)}:**\n\n`;
  
  const selectOptions: { label: string; value: string; description?: string }[] = [];
  
  for (let i = 0; i < settings.slots.length; i++) {
    const slot = settings.slots[i];
    
    // Check existing signups
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
    const durationHours = parseInt(slot.end.split(':')[0]) - parseInt(slot.start.split(':')[0]);
    const reward = durationHours * settings.rewardAmountPerHour;
    
    // Get room events for this slot from memory cache (zero API calls)
    const slotRoomEvents = cache.getEventsForSlot(date, slot.start, slot.end);
    const roomEvents = slotRoomEvents.map(e => `${e.room}: ${e.title}`);
    
    let label = `${formatTime(slot.start)} - ${formatTime(slot.end)}`;
    let description = `${reward} ${settings.rewardTokenSymbol}`;
    
    if (isFull) {
      label = `🔴 ${label} (full)`;
    } else if (signups.length > 0) {
      label = `🟡 ${label} (${spotsLeft}/${settings.maxSignupsPerSlot} spots)`;
      description += ` · with ${signups.map(s => s.username).join(", ")}`;
    } else {
      label = `🟢 ${label} (${settings.maxSignupsPerSlot} spots)`;
    }
    
    if (roomEvents.length > 0) {
      description += ` · ${roomEvents.length} room event${roomEvents.length > 1 ? 's' : ''}`;
    }
    
    // Add slot details to content
    content += `**${formatTime(slot.start)} - ${formatTime(slot.end)}** (${durationHours}h)\n`;
    if (signups.length > 0) {
      content += `  👥 Signed up: ${signups.map(s => s.username).join(", ")}\n`;
    }
    if (roomEvents.length > 0) {
      content += `  🏢 Events: ${roomEvents.join(", ")}\n`;
    }
    content += `  💰 Earn ${reward} ${settings.rewardTokenSymbol}\n\n`;
    
    // Only add non-full slots to dropdown
    if (!isFull) {
      selectOptions.push({
        label: label.substring(0, 100),
        value: `${i}`,
        description: description.substring(0, 100),
      });
    }
  }

  const components: any[] = [];

  if (selectOptions.length > 0) {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("shifts_slot_select")
      .setPlaceholder("Select a time slot...")
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
      
      const updatedDescription = updateEventDescription(existingEvent.description || "", newSignup);
      
      const updateData: any = { description: updatedDescription };
      if (state.email) {
        updateData.attendees = [...(existingEvent.attendees || []), { email: state.email }];
      }
      await calendar.updateEvent(settings.calendarId, existingEvent.id!, updateData);
      
    } else {
      // Create new event
      const eventTitle = `Shift: ${formatTime(selectedSlot.start)}-${formatTime(selectedSlot.end)}`;
      const description = `signup: discord:${userId}:${interaction.user.username}${state.email ? ':' + state.email : ''}`;
      
      const calendarEvent: any = {
        summary: eventTitle,
        description,
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
      
      await calendar.createEventNoConflictCheck(settings.calendarId, calendarEvent);
    }

    // Invalidate caches after signup
    invalidateShiftCaches();

    await interaction.editReply({
      content: `✅ **Shift signup confirmed!**

**Date:** ${formatDate(selectedDate)}
**Time:** ${formatTime(selectedSlot.start)} - ${formatTime(selectedSlot.end)}
**Reward:** ${(parseInt(selectedSlot.end.split(':')[0]) - parseInt(selectedSlot.start.split(':')[0])) * settings.rewardAmountPerHour} ${settings.rewardTokenSymbol}

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
async function cancelShift(shiftEvent: CalendarEvent, userId: string, settings: ShiftsSettings) {
  const calendar = new GoogleCalendarClient();
  
  const signups = parseShiftSignups(shiftEvent.description || "");
  const userSignup = signups.find(s => s.discordUserId === userId);
  
  if (!userSignup) {
    throw new Error("You're not signed up for this shift");
  }
  
  const remainingSignups = signups.filter(s => s.discordUserId !== userId);
  
  if (remainingSignups.length === 0) {
    // Delete the entire event if no one else is signed up
    await calendar.deleteEvent(settings.calendarId, shiftEvent.id!);
  } else {
    // Update event description to remove the user
    const updatedDescription = remainingSignups
      .map(s => `signup: discord:${s.discordUserId}:${s.username}${s.email ? ':' + s.email : ''}`)
      .join('\n');
    
    await calendar.updateEvent(settings.calendarId, shiftEvent.id!, {
      description: updatedDescription,
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
    const guildSettings = await loadGuildSettings(guildId);
    if (!guildSettings) {
      throw new Error("Guild settings not found");
    }

    const token = guildSettings.tokens.find(t => t.symbol === settings.rewardTokenSymbol);
    if (!token) {
      throw new Error(`Token ${settings.rewardTokenSymbol} not configured`);
    }

    const results: { userId: string; username: string; amount: number; success: boolean; hash?: string; error?: string }[] = [];

    // Mint tokens for each participant
    for (const participantUserId of state.rewardParticipants!) {
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

        const signups = parseShiftSignups(state.selectedRewardEvent!.description || "");
        const signup = signups.find(s => s.discordUserId === participantUserId);
        
        results.push({
          userId: participantUserId,
          username: signup?.username || "Unknown",
          amount,
          success: true,
          hash: hash ?? undefined
        });

      } catch (error) {
        const signups = parseShiftSignups(state.selectedRewardEvent!.description || "");
        const signup = signups.find(s => s.discordUserId === participantUserId);
        
        results.push({
          userId: participantUserId,
          username: signup?.username || "Unknown",
          amount: state.rewardAmounts![participantUserId],
          success: false,
          error: String(error)
        });
      }
    }

    // Update calendar event with reward info
    const successfulRewards = results.filter(r => r.success);
    if (successfulRewards.length > 0) {
      const calendar = new GoogleCalendarClient();
      const originalDescription = state.selectedRewardEvent!.description || "";
      
      let rewardSection = `\n---\nToken rewards:`;
      for (const result of successfulRewards) {
        rewardSection += `\n- @${result.username}: ${result.amount} ${settings.rewardTokenSymbol} (tx: ${result.hash})`;
      }
      rewardSection += `\nRewarded by: @${interaction.user.username} (discord:${userId})`;
      
      await calendar.updateEvent(settings.calendarId, state.selectedRewardEvent!.id!, {
        description: originalDescription + rewardSection
      });
    }

    // Build response message
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

    await interaction.editReply({
      content,
    });

    shiftsStates.delete(userId);

  } catch (error) {
    console.error("Error processing rewards:", error);
    await interaction.editReply({
      content: "❌ Error processing rewards. Please try again.",
    });
  }
}