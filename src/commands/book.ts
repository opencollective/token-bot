import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from "discord.js";
import { BookState, Product } from "../types.ts";
import { loadGuildFile, loadGuildSettings } from "../lib/utils.ts";
import { disabledCalendars } from "../lib/calendar-state.ts";
import { GoogleCalendarClient } from "../lib/googlecalendar.ts";
import { invalidateRoomEventsCache } from "../lib/room-events-cache.ts";
import { burnTokensFrom, getBalance, SupportedChain } from "../lib/blockchain.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { formatUnits, parseUnits } from "@wevm/viem";
import { getUser, getUserEmail, saveUser } from "../lib/user-emails.ts";
import { fetchRoomImage, ratesFromPrices, sendBookingConfirmation } from "../lib/booking-email.ts";
import { recordGuestBooking } from "../lib/guest-bookings.ts";
import { bookingReason, buildDoorLink } from "../lib/door-link.ts";
import { findConflict, MAX_BOOKING_DATES, type Occurrence, occurrencesFor, parseDateList } from "../lib/book-dates.ts";

// Update the /book message. Clicks are acknowledged right away (deferUpdate, see
// ackClick) so the slow work after them (Google Calendar, wallet, balance) is not
// bound by Discord's 3-second limit; once acknowledged, the message is edited.
async function updateMessage(interaction: Interaction, data: { content: string; components?: any[] }) {
  if (!interaction.isRepliable()) return;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(data);
  } else if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) && "update" in interaction) {
    await updateMessage(interaction, data);
  } else if (interaction.isModalSubmit()) {
    await interaction.editReply(data);
  }
}

// ── Booking on behalf of another member or a guest ─────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Short label for who the booking is for ("Ana (guest)", "<@123>"), or "" when it is for the booker. */
function forLabel(state: BookState, mention = true): string {
  const f = state.bookedFor;
  if (!f) return "";
  if (f.kind === "guest") return `${f.name} (guest)`;
  return mention ? `<@${f.discordUserId}>` : f.displayName;
}

/** One line for the booker about the calendar invitation, or "" when the booking is for themselves. */
function inviteNote(state: BookState, invite: { invited: boolean; inviteError?: string }): string {
  if (!state.bookedFor) return "";
  if (invite.invited) return `📧 Calendar invitation sent to ${forLabel(state, false)}.\n\n`;
  if (state.bookedFor.kind === "member" && !state.bookedFor.email) return `ℹ️ No calendar invitation: we don't know ${forLabel(state, false)}'s email.\n\n`;
  return `⚠️ The booking is made, but the calendar invitation could not be sent (${invite.inviteError || "unknown error"}). Please forward the details to ${forLabel(state, false)}.\n\n`;
}

/** Email the guest a confirmation (cc the booker) and return one line for the booker's reply. */
async function emailGuest(
  state: BookState,
  interaction: Interaction,
  guildId: string,
  userId: string,
  product: Product,
  occurrences: (Occurrence & { eventId?: string })[],
  total: number,
  tokenSymbol: string,
  txUrl: string,
  bookingId: string,
): Promise<string> {
  const f = state.bookedFor;
  if (f?.kind !== "guest" || occurrences.length === 0) return "";
  const bookerEmail = getUserEmail(guildId, userId);
  const bookerName = interaction.user.displayName || interaction.user.username;
  try {
    const doorLinks = await Promise.all(occurrences.map((o) =>
      buildDoorLink({ name: f.name, host: bookerName, reason: bookingReason(product.name, o.start, o.end), start: o.start, end: o.end })
        .catch((error) => { console.error("[book] door link failed:", error?.message || error); return null; })
    ));
    const uids = occurrences.map((o, i) => o.eventId ? `${o.eventId}@commonshub.brussels` : `${bookingId}-${i}@commonshub.brussels`);
    await sendBookingConfirmation({
      doorLinks,
      uids,
      roomImageUrl: await fetchRoomImage(product.slug),
      rates: ratesFromPrices(product.price, product.capacity),
      guestName: f.name,
      guestEmail: f.email,
      bookerName: interaction.user.displayName || interaction.user.username,
      bookerEmail,
      eventName: state.name || "Room booking",
      roomName: product.name,
      occurrences,
      priceTotal: total,
      tokenSymbol,
      eventUrl: state.eventUrl,
      txUrl,
      bookingId,
    });
    // Remember it, so the guest can be told if the booking is changed or cancelled.
    for (const [i, o] of occurrences.entries()) {
      if (!o.eventId || !product.calendarId) continue;
      await recordGuestBooking(guildId, {
        calendarId: product.calendarId, eventId: o.eventId, uid: uids[i], sequence: 0,
        productSlug: product.slug, roomName: product.name,
        guestName: f.name, guestEmail: f.email,
        bookerId: userId, bookerName, bookerEmail,
        eventName: state.name || "Room booking",
        start: o.start.toISOString(), end: o.end.toISOString(), eventUrl: state.eventUrl,
        tokenSymbol, priceTotal: total / occurrences.length, status: "active",
      }).catch((error) => console.error("[book] could not record the guest booking:", error?.message || error));
    }
    const withDoor = doorLinks.some(Boolean) ? ", with a link to open the door" : "";
    return `📨 Confirmation email sent to ${f.name}${withDoor}${bookerEmail ? " (you are in cc)" : ""}.\n\n`;
  } catch (error: any) {
    console.error("[book] guest confirmation email failed:", error?.message || error);
    return `⚠️ The confirmation email to ${f.name} could not be sent (${String(error?.message || error).slice(0, 120)}).\n\n`;
  }
}

/** Emails to invite to the calendar event: the guest or member it is for, and the booker when known. */
function inviteEmails(state: BookState, guildId: string, bookerId: string): string[] {
  const emails = new Set<string>();
  const f = state.bookedFor;
  if (f?.kind === "guest") emails.add(f.email.toLowerCase());
  if (f?.kind === "member") {
    const email = f.email || getUserEmail(guildId, f.discordUserId);
    if (email) emails.add(email.toLowerCase());
  }
  if (f) {
    const bookerEmail = getUserEmail(guildId, bookerId);
    if (bookerEmail) emails.add(bookerEmail.toLowerCase());
  }
  return [...emails];
}

/**
 * Create the booking event. With invitees it goes through a Workspace account the service
 * account may act for (service accounts cannot invite guests), which needs writer access to
 * the room calendar. If that fails the event is still created, without invitations.
 */
async function createBookingEvent(
  calendarId: string,
  event: any,
  invitees: string[],
): Promise<{ invited: boolean; inviteError?: string; eventId?: string }> {
  const asUser = Deno.env.get("BOOKING_CALENDAR_IMPERSONATE_USER") || Deno.env.get("GOOGLE_CALENDAR_IMPERSONATE_USER");
  if (invitees.length > 0 && asUser) {
    try {
      const created: any = await new GoogleCalendarClient({ impersonateUser: asUser }).createEvent(
        calendarId,
        { ...event, attendees: invitees.map((email) => ({ email })) },
        { sendUpdates: "all" },
      );
      return { invited: true, eventId: created?.id };
    } catch (error: any) {
      if (error?.conflictingEvent) throw error;
      console.error(`[book] could not create the event with invitations as ${asUser}, retrying without:`, error?.message || error);
      const created: any = await new GoogleCalendarClient().createEvent(calendarId, event);
      return { invited: false, inviteError: String(error?.message || error).slice(0, 160), eventId: created?.id };
    }
  }
  const created: any = await new GoogleCalendarClient().createEvent(calendarId, event);
  return { invited: false, inviteError: invitees.length ? "no Workspace account configured to send invitations" : undefined, eventId: created?.id };
}

// Clicks that open a modal must answer with the modal itself, so they are not deferred.
const MODAL_BUTTONS = new Set(["book_date_custom", "book_custom_name", "book_for_guest"]);

/** Acknowledge a /book click immediately (Discord allows 3 s); the message is updated afterwards. */
async function ackClick(interaction: Interaction): Promise<void> {
  if (!(interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu())) return;
  if (interaction.deferred || interaction.replied || MODAL_BUTTONS.has(interaction.customId)) return;
  await interaction.deferUpdate();
}

// Cache for Discord ID to blockchain address mapping
const addressCache = new Map<string, string>();

// Helper function to get blockchain address with caching
async function getCachedAddress(discordUserId: string): Promise<string> {
  if (addressCache.has(discordUserId)) {
    return addressCache.get(discordUserId)!;
  }

  const address = await getAccountAddressFromDiscordUserId(discordUserId);
  if (!address) throw new Error("No wallet address found");
  addressCache.set(discordUserId, address);
  return address;
}

export const bookStates = new Map<string, BookState>();

// Helper function to format duration for display
function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h${remainingMinutes}`;
}

// Helper function to format date for Discord messages
function formatDiscordDate(date: Date): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  const dayNum = date.getDate();

  // Add ordinal suffix (st, nd, rd, th)
  let suffix = "th";
  if (dayNum === 1 || dayNum === 21 || dayNum === 31) suffix = "st";
  else if (dayNum === 2 || dayNum === 22) suffix = "nd";
  else if (dayNum === 3 || dayNum === 23) suffix = "rd";

  return `${dayName} ${monthName} ${dayNum}${suffix}`;
}

// Helper function to format short date
function formatShortDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[date.getDay()]} ${date.getDate()}/${date.getMonth() + 1}`;
}

// Helper function to format time for Discord messages (2:30pm)
function formatDiscordTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 should be 12
  const minutesStr = minutes < 10 ? `0${minutes}` : minutes.toString();
  return `${hours}:${minutesStr}${ampm}`;
}

// Get today's date at midnight in local time
function getLocalToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Get upcoming dates for selection (today + next 6 days)
function getDateOptions(): { label: string; value: string; date: Date }[] {
  const options: { label: string; value: string; date: Date }[] = [];
  const today = getLocalToday();
  
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    
    let label: string;
    if (i === 0) {
      label = "Today";
    } else if (i === 1) {
      label = "Tomorrow";
    } else {
      const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
      label = `${dayName} (${date.getDate()}/${date.getMonth() + 1})`;
    }
    
    // Store as YYYY-MM-DD format with explicit year/month/day to avoid timezone issues
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    
    options.push({ label, value, date });
  }
  
  return options;
}

// Parse date value back to Date object (in local time)
function parseDateValue(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

interface CalendarEvent {
  start: { dateTime: string };
  end: { dateTime: string };
  summary?: string;
}

// Check if a time slot overlaps with any booked event
function isSlotBooked(
  slotHour: number,
  slotMinute: number,
  selectedDate: Date,
  bookedEvents: CalendarEvent[],
): boolean {
  const slotStart = new Date(selectedDate);
  slotStart.setHours(slotHour, slotMinute, 0, 0);
  
  // A slot is "booked" if any event overlaps with its start time
  // (i.e., event starts before slot ends AND event ends after slot starts)
  for (const event of bookedEvents) {
    const eventStart = new Date(event.start.dateTime);
    const eventEnd = new Date(event.end.dateTime);
    
    // Check if this slot's start time falls within an event
    if (slotStart >= eventStart && slotStart < eventEnd) {
      return true;
    }
  }
  
  return false;
}

// Get available time slots (30-min intervals)
function getTimeSlots(
  selectedDate: Date,
  isToday: boolean,
  bookedEvents: CalendarEvent[] = [],
): { label: string; value: string; booked: boolean }[] {
  const slots: { label: string; value: string; booked: boolean }[] = [];
  const now = new Date();
  
  // Start hour: if today, start from next half hour; otherwise 8am
  let startHour = 8;
  let startMinute = 0;
  
  if (isToday) {
    startHour = now.getHours();
    startMinute = now.getMinutes() < 30 ? 30 : 0;
    if (now.getMinutes() >= 30) {
      startHour++;
    }
    // If it's past 10pm, no slots available
    if (startHour >= 22) {
      return [];
    }
    // Minimum start is 8am
    if (startHour < 8) {
      startHour = 8;
      startMinute = 0;
    }
  }
  
  const endHour = 22; // 10pm
  
  for (let hour = startHour; hour <= endHour; hour++) {
    for (const minute of [0, 30]) {
      // Skip if before start time
      if (hour === startHour && minute < startMinute) continue;
      // Skip 10:30pm (can't book past 10pm)
      if (hour === 22 && minute === 30) continue;
      
      const hour12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
      const ampm = hour >= 12 ? "pm" : "am";
      const minuteStr = minute === 0 ? "00" : "30";
      
      const booked = isSlotBooked(hour, minute, selectedDate, bookedEvents);
      const label = booked 
        ? `🔴 ${hour12}:${minuteStr}${ampm}` 
        : `🟢 ${hour12}:${minuteStr}${ampm}`;
      
      slots.push({
        label,
        value: `${hour}:${minute}`,
        booked,
      });
    }
  }
  
  return slots;
}

// Duration options in minutes
const DURATION_OPTIONS = [
  { label: "30 min", value: "30" },
  { label: "1 hour", value: "60" },
  { label: "1h 30min", value: "90" },
  { label: "2 hours", value: "120" },
  { label: "3 hours", value: "180" },
  { label: "4 hours", value: "240" },
  { label: "5 hours", value: "300" },
];

// Format events for availability display
async function formatAvailability(
  calendarId: string,
  date: Date,
): Promise<string> {
  try {
    const calendar = new GoogleCalendarClient();
    
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    const events = await calendar.listEvents(calendarId, startOfDay, endOfDay);
    
    if (events.length === 0) {
      return `✅ Available all day (8am - 10pm)`;
    }
    
    let availability = `**Booked slots:**\n`;
    
    for (const event of events) {
      const start = new Date(event.start.dateTime);
      const end = new Date(event.end.dateTime);
      availability += `🔴 ${formatDiscordTime(start)} - ${formatDiscordTime(end)}: ${event.summary || "Booked"}\n`;
    }
    
    return availability;
  } catch (error) {
    console.error("Error fetching availability:", error);
    return `⚠️ Could not fetch availability`;
  }
}

// Build the header showing current selection state
function buildSelectionHeader(state: BookState, product?: Product): string {
  let header = `🗓️ **Book a Room**\n\n`;
  
  if (product) {
    header += `**Room:** ${product.name}\n`;
  }
  
  if (state.selectedDates && state.selectedDates.length > 1) {
    header += `**Dates (${state.selectedDates.length}):** ${state.selectedDates.map(formatShortDate).join(", ")}\n`;
  } else if (state.selectedDate) {
    header += `**Date:** ${formatDiscordDate(state.selectedDate)}\n`;
  }
  
  if (state.selectedHour !== undefined && state.selectedMinute !== undefined) {
    const hour12 = state.selectedHour > 12 ? state.selectedHour - 12 : state.selectedHour === 0 ? 12 : state.selectedHour;
    const ampm = state.selectedHour >= 12 ? "pm" : "am";
    const minuteStr = state.selectedMinute === 0 ? "00" : "30";
    header += `**Time:** ${hour12}:${minuteStr}${ampm}\n`;
  }
  
  if (state.duration) {
    header += `**Duration:** ${formatDuration(state.duration)}\n`;
  }

  if (state.bookedFor) {
    header += `**For:** ${forLabel(state)}\n`;
  }
  
  return header;
}

export async function handleBookCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  // Load products (rooms) for selection
  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  // Filter to rooms with calendars that have write access
  const bookableRooms = products?.filter((p) => 
    p.type === "room" && 
    p.calendarId && 
    !disabledCalendars.has(p.calendarId)
  ) || [];

  if (bookableRooms.length === 0) {
    // Check if there are rooms but all are disabled
    const allRooms = products?.filter((p) => p.type === "room" && p.calendarId) || [];
    if (allRooms.length > 0) {
      await interaction.reply({
        content: "⚠️ All room calendars are currently unavailable (missing write permissions). Please contact an administrator.",
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: "⚠️ No bookable rooms configured.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  // Initialize booking state
  bookStates.set(userId, {
    step: "room",
    guildId,
  });

  // Build room list with details
  let roomList = "";
  for (const room of bookableRooms) {
    const capacityStr = room.capacity ? `👥 ${room.capacity}` : "";
    const priceStr = room.price[0] ? `${room.price[0].amount} ${room.price[0].token}/h` : "";
    roomList += `• **${room.name}** — ${capacityStr} · ${priceStr}\n`;
  }

  // Build room selection buttons
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  
  // Split rooms into rows of 3
  for (let i = 0; i < bookableRooms.length; i += 3) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const chunk = bookableRooms.slice(i, i + 3);
    
    for (const room of chunk) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`book_room_${room.slug}`)
          .setLabel(room.name)
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
    
    // Discord allows max 5 rows
    if (rows.length >= 4) break;
  }
  
  // Add cancel button
  const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );
  rows.push(cancelRow);

  await interaction.reply({
    content: `🗓️ **Book a Room**\n\n${roomList}\n🏠 **Select a room:**`,
    components: rows,
    flags: MessageFlags.Ephemeral,
  });
}

// Show date selection UI
async function showDateSelection(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton()) return;

  const state = bookStates.get(userId);
  if (!state || !state.productSlug) return;

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === state.productSlug);

  // Build date selection buttons
  const dateOptions = getDateOptions();
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  
  // First row: Today, Tomorrow
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`book_date_${dateOptions[0].value}`)
      .setLabel(dateOptions[0].label)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`book_date_${dateOptions[1].value}`)
      .setLabel(dateOptions[1].label)
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(row1);
  
  // Second row: Next 4 days
  const row2 = new ActionRowBuilder<ButtonBuilder>();
  for (let i = 2; i < Math.min(6, dateOptions.length); i++) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`book_date_${dateOptions[i].value}`)
        .setLabel(dateOptions[i].label)
        .setStyle(ButtonStyle.Secondary),
    );
  }
  rows.push(row2);
  
  // Third row: Last day + Other + Custom + Cancel
  const row3 = new ActionRowBuilder<ButtonBuilder>();
  if (dateOptions.length > 6) {
    row3.addComponents(
      new ButtonBuilder()
        .setCustomId(`book_date_${dateOptions[6].value}`)
        .setLabel(dateOptions[6].label)
        .setStyle(ButtonStyle.Secondary),
    );
  }
  row3.addComponents(
    new ButtonBuilder()
      .setCustomId("book_date_other")
      .setLabel("Next 2 weeks...")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("book_date_custom")
      .setLabel("Enter date(s)...")
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(row3);
  
  // Navigation row
  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_back_room")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("book_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );
  rows.push(navRow);

  const header = buildSelectionHeader(state, product);

  await updateMessage(interaction, {
    content: `${header}\n📅 **Select a date:**`,
    components: rows,
  });
}

export async function handleBookButton(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  const state = bookStates.get(userId);
  await ackClick(interaction);

  // Cancel button
  if (customId === "book_cancel") {
    bookStates.delete(userId);
    await updateMessage(interaction, {
      content: "❌ Booking cancelled.",
      components: [],
    });
    return;
  }

  // Room selection
  if (customId.startsWith("book_room_")) {
    if (!state) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    const roomSlug = customId.replace("book_room_", "");
    
    // Verify room exists and has write access
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === roomSlug);

    if (!product || !product.calendarId) {
      await updateMessage(interaction, {
        content: "⚠️ This room is not available for booking.",
        components: [],
      });
      return;
    }

    if (disabledCalendars.has(product.calendarId)) {
      await updateMessage(interaction, {
        content: "⚠️ This room's calendar is currently unavailable (missing write permissions). Please contact an administrator.",
        components: [],
      });
      return;
    }

    state.productSlug = roomSlug;
    state.step = "date";
    bookStates.set(userId, state);

    await showDateSelection(interaction, userId, guildId);
    return;
  }

  // Date selection
  if (customId.startsWith("book_date_")) {
    if (!state) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    const dateValue = customId.replace("book_date_", "");

    if (dateValue === "custom") {
      // Show modal for custom date entry
      const modal = new ModalBuilder()
        .setCustomId("book_date_modal")
        .setTitle("Enter one or more dates")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("custom_date")
              .setLabel("Date(s), DD/MM/YYYY, comma separated")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("15/03/2026  or  15/03/2026, 22/03/2026, 29/03/2026")
              .setRequired(true)
              .setMaxLength(200),
          ),
        );
      await interaction.showModal(modal);
      return;
    }
    
    if (dateValue === "other") {
      // Extended date selection via dropdown
      const extendedDates: { label: string; value: string }[] = [];
      const today = getLocalToday();
      
      for (let i = 7; i < 21; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        extendedDates.push({
          label: formatShortDate(date),
          value,
        });
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("book_date_select")
        .setPlaceholder("Select a date...")
        .addOptions(extendedDates.slice(0, 25).map(d => ({
          label: d.label,
          value: d.value,
        })));

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
      const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("book_back_date")
          .setLabel("← Back")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("book_cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      );

      const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
      const product = products?.find((p) => p.slug === state.productSlug);
      const header = buildSelectionHeader(state, product);

      await updateMessage(interaction, {
        content: `${header}\n📅 **Select a date from the next 2 weeks:**`,
        components: [row, cancelRow],
      });
      return;
    }

    // Parse the selected date
    const selectedDate = parseDateValue(dateValue);
    state.selectedDate = selectedDate;
    state.selectedDates = undefined;
    state.step = "time";
    bookStates.set(userId, state);

    await showTimeSelection(interaction, userId, guildId);
    return;
  }

  // Back to date selection
  if (customId === "book_back_date") {
    if (!state) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    state.step = "date";
    state.selectedDate = undefined;
    state.selectedHour = undefined;
    state.selectedMinute = undefined;
    bookStates.set(userId, state);

    // Rebuild date selection
    const dateOptions = getDateOptions();
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`book_date_${dateOptions[0].value}`)
        .setLabel(dateOptions[0].label)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`book_date_${dateOptions[1].value}`)
        .setLabel(dateOptions[1].label)
        .setStyle(ButtonStyle.Secondary),
    );
    rows.push(row1);
    
    const row2 = new ActionRowBuilder<ButtonBuilder>();
    for (let i = 2; i < Math.min(6, dateOptions.length); i++) {
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(`book_date_${dateOptions[i].value}`)
          .setLabel(dateOptions[i].label)
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row2);
    
    const row3 = new ActionRowBuilder<ButtonBuilder>();
    if (dateOptions.length > 6) {
      row3.addComponents(
        new ButtonBuilder()
          .setCustomId(`book_date_${dateOptions[6].value}`)
          .setLabel(dateOptions[6].label)
          .setStyle(ButtonStyle.Secondary),
      );
    }
    row3.addComponents(
      new ButtonBuilder()
        .setCustomId("book_date_other")
        .setLabel("Next 2 weeks...")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("book_date_custom")
        .setLabel("Enter date...")
        .setStyle(ButtonStyle.Secondary),
    );
    rows.push(row3);
    
    // Navigation row
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("book_back_room")
        .setLabel("← Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("book_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );
    rows.push(navRow);

    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === state.productSlug);
    const header = buildSelectionHeader(state, product);

    await updateMessage(interaction, {
      content: `${header}\n📅 **Select a date:**`,
      components: rows,
    });
    return;
  }

  // Back to room selection
  if (customId === "book_back_room") {
    if (!state) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    state.step = "room";
    state.productSlug = undefined;
    state.selectedDate = undefined;
    state.selectedHour = undefined;
    state.selectedMinute = undefined;
    bookStates.set(userId, state);

    // Rebuild room selection (filter out disabled calendars)
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const bookableRooms = products?.filter((p) => 
      p.type === "room" && 
      p.calendarId && 
      !disabledCalendars.has(p.calendarId)
    ) || [];

    // Build room list with details
    let roomList = "";
    for (const room of bookableRooms) {
      const capacityStr = room.capacity ? `👥 ${room.capacity}` : "";
      const priceStr = room.price[0] ? `${room.price[0].amount} ${room.price[0].token}/h` : "";
      roomList += `• **${room.name}** — ${capacityStr} · ${priceStr}\n`;
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    
    for (let i = 0; i < bookableRooms.length; i += 3) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const chunk = bookableRooms.slice(i, i + 3);
      
      for (const room of chunk) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`book_room_${room.slug}`)
            .setLabel(room.name)
            .setStyle(ButtonStyle.Secondary),
        );
      }
      rows.push(row);
      
      if (rows.length >= 4) break;
    }
    
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("book_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );
    rows.push(cancelRow);

    await updateMessage(interaction, {
      content: `🗓️ **Book a Room**\n\n${roomList}\n🏠 **Select a room:**`,
      components: rows,
    });
    return;
  }

  // Back to time selection
  if (customId === "book_back_time") {
    if (!state || !state.selectedDate) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    state.step = "time";
    state.selectedHour = undefined;
    state.selectedMinute = undefined;
    state.duration = undefined;
    bookStates.set(userId, state);

    await showTimeSelection(interaction, userId, guildId);
    return;
  }

  // Duration selection
  if (customId.startsWith("book_duration_")) {
    if (!state || !state.selectedDate || state.selectedHour === undefined || state.selectedMinute === undefined) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    const durationMinutes = parseInt(customId.replace("book_duration_", ""));
    state.duration = durationMinutes;
    state.step = "name";
    bookStates.set(userId, state);

    await showNameInput(interaction, userId, guildId);
    return;
  }

  // Back to duration selection
  if (customId === "book_back_duration") {
    if (!state || !state.selectedDate || state.selectedHour === undefined) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    state.step = "duration";
    state.duration = undefined;
    state.name = undefined;
    bookStates.set(userId, state);

    await showDurationSelection(interaction, userId, guildId);
    return;
  }

  // Use default name
  if (customId === "book_for_me" || customId === "book_for_back") {
    if (!state || !state.selectedDate || !state.duration) {
      await updateMessage(interaction, { content: "⚠️ Session expired. Please run /book again.", components: [] });
      return;
    }
    if (customId === "book_for_me") state.bookedFor = undefined;
    bookStates.set(userId, state);
    await showNameInput(interaction, userId, guildId);
    return;
  }

  if (customId === "book_for_member") {
    if (!state || !state.selectedDate || !state.duration) {
      await updateMessage(interaction, { content: "⚠️ Session expired. Please run /book again.", components: [] });
      return;
    }
    const picker = new UserSelectMenuBuilder()
      .setCustomId("book_for_member_select")
      .setPlaceholder("Select the member this booking is for")
      .setMinValues(1)
      .setMaxValues(1);
    await updateMessage(interaction, {
      content: `${buildSelectionHeader(state)}\n👤 **Who is this booking for?** You pay; they get the calendar invitation if we know their email.`,
      components: [
        new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(picker),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("book_for_back").setLabel("← Back").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("book_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  if (customId === "book_for_guest") {
    if (!state || !state.selectedDate || !state.duration) {
      await updateMessage(interaction, { content: "⚠️ Session expired. Please run /book again.", components: [] });
      return;
    }
    const knownEmail = getUserEmail(guildId, userId);
    const modal = new ModalBuilder().setCustomId("book_guest_modal").setTitle("Book for a guest");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("guest_name").setLabel("Guest name").setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(80).setValue(state.bookedFor?.kind === "guest" ? state.bookedFor.name : ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("guest_email").setLabel("Guest email (receives the calendar invite)").setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(120).setPlaceholder("guest@example.com").setValue(state.bookedFor?.kind === "guest" ? state.bookedFor.email : ""),
      ),
    );
    if (!knownEmail) {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("booker_email").setLabel("Your email (we don't have it yet)").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(120).setPlaceholder("you@example.com"),
        ),
      );
    }
    await interaction.showModal(modal);
    return;
  }

  if (customId === "book_use_default_name") {
    if (!state || !state.selectedDate || state.selectedHour === undefined || !state.duration) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    state.name = `${state.bookedFor ? forLabel(state, false).replace(/ \(guest\)$/, "") : interaction.user.displayName}'s booking`.slice(0, 100);
    state.step = "payment";
    bookStates.set(userId, state);

    await showPaymentSelection(interaction, userId, guildId);
    return;
  }

  // Payment method selection
  if (customId.startsWith("book_pay_")) {
    if (!state || !state.name || !state.duration) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    const tokenSymbol = customId.replace("book_pay_", "");
    state.selectedToken = tokenSymbol;
    state.step = "confirm";
    bookStates.set(userId, state);

    await showConfirmation(interaction, userId, guildId);
    return;
  }

  // Back from confirmation - go to payment if multiple options, otherwise back to name
  if (customId === "book_back_payment") {
    if (!state || !state.name) {
      await updateMessage(interaction, {
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    // Check if there are multiple payment options
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === state.productSlug);
    const guildSettings = await loadGuildSettings(guildId);
    
    const validPriceCount = product?.price?.filter((p) =>
      guildSettings?.tokens.some((t) => t.symbol.toLowerCase() === p.token.toLowerCase())
    ).length || 0;

    if (validPriceCount > 1) {
      // Multiple payment options - show payment selection
      state.step = "payment";
      state.selectedToken = undefined;
      bookStates.set(userId, state);
      await showPaymentSelection(interaction, userId, guildId);
    } else {
      // Single payment option - skip payment, go back to name
      state.step = "name";
      state.name = undefined;
      state.selectedToken = undefined;
      bookStates.set(userId, state);
      await showNameInput(interaction, userId, guildId);
    }
    return;
  }

  // Custom name button - show modal
  if (customId === "book_custom_name") {
    const modal = new ModalBuilder()
      .setCustomId("book_name_modal")
      .setTitle("Event Details")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("event_name")
            .setLabel("What's this booking for?")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g., Team Meeting, Workshop, Client Call")
            .setRequired(true)
            .setMaxLength(100),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("event_url")
            .setLabel("Event URL (optional)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("https://lu.ma/your-event")
            .setRequired(false)
            .setMaxLength(500),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  // Final confirmation
  if (customId === "book_confirm") {
    await processBooking(interaction, userId, guildId);
    return;
  }
}

// Show time selection UI
async function showTimeSelection(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

  const state = bookStates.get(userId);
  if (!state || !state.selectedDate) return;

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === state.productSlug);

  // Fetch events for the selected date to show booked times
  let bookedEvents: CalendarEvent[] = [];
  if (product?.calendarId) {
    try {
      const calendar = new GoogleCalendarClient();
      const startOfDay = new Date(state.selectedDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(state.selectedDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      const events = await calendar.listEvents(product.calendarId, startOfDay, endOfDay);
      bookedEvents = events.map(e => ({
        start: { dateTime: e.start.dateTime },
        end: { dateTime: e.end.dateTime },
        summary: e.summary,
      }));
    } catch (error) {
      console.error("Error fetching calendar events:", error);
    }
  }

  // Get availability display
  const availability = product?.calendarId 
    ? await formatAvailability(product.calendarId, state.selectedDate)
    : "";

  const today = getLocalToday();
  const isToday = state.selectedDate.getTime() === today.getTime();
  const timeSlots = getTimeSlots(state.selectedDate, isToday, bookedEvents);

  if (timeSlots.length === 0) {
    await updateMessage(interaction, {
      content: `${buildSelectionHeader(state, product)}\n${availability}\n\n⚠️ No available time slots left for today. Please select a different date.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("book_back_date")
            .setLabel("← Back to date selection")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("book_cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  // Use a select menu for time to avoid too many buttons
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("book_time_select")
    .setPlaceholder("Select a start time...")
    .addOptions(timeSlots.slice(0, 25).map(slot => ({
      label: slot.label,
      value: slot.value,
      description: slot.booked ? "booked" : undefined,
    })));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  
  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_back_date")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("book_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  const header = buildSelectionHeader(state, product);

  const multiNote = state.selectedDates && state.selectedDates.length > 1
    ? `\n_Availability shown for ${formatShortDate(state.selectedDate)}. The same time is used on every date, and each date is checked before you pay._`
    : "";

  await updateMessage(interaction, {
    content: `${header}\n${availability}${multiNote}\n\n⏰ **Select start time:** (🔴 = booked)`,
    components: [row, navRow],
  });
}

// Show duration selection UI
async function showDurationSelection(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  const state = bookStates.get(userId);
  if (!state || !state.selectedDate) return;

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === state.productSlug);

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...DURATION_OPTIONS.slice(0, 4).map(d =>
      new ButtonBuilder()
        .setCustomId(`book_duration_${d.value}`)
        .setLabel(d.label)
        .setStyle(ButtonStyle.Secondary)
    ),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...DURATION_OPTIONS.slice(4).map(d =>
      new ButtonBuilder()
        .setCustomId(`book_duration_${d.value}`)
        .setLabel(d.label)
        .setStyle(ButtonStyle.Secondary)
    ),
  );

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_back_time")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("book_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  const header = buildSelectionHeader(state, product);

  await updateMessage(interaction, {
    content: `${header}\n⏱️ **Select duration:**`,
    components: [row1, row2, navRow],
  });
}

// Show name input UI
async function showNameInput(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isUserSelectMenu() && !interaction.isModalSubmit()) return;

  const state = bookStates.get(userId);
  if (!state || !state.selectedDate || !state.duration) return;

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === state.productSlug);

  const who = state.bookedFor ? forLabel(state, false).replace(/ \(guest\)$/, "") : interaction.user.displayName;
  const defaultName = `${who}'s booking`.slice(0, 70);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_use_default_name")
      .setLabel(`Use "${defaultName}"`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("book_custom_name")
      .setLabel("Custom name...")
      .setStyle(ButtonStyle.Secondary),
  );

  const forRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_for_me")
      .setLabel("For me")
      .setStyle(state.bookedFor ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("book_for_member")
      .setLabel(state.bookedFor?.kind === "member" ? `For ${forLabel(state, false)}`.slice(0, 80) : "For another member...")
      .setStyle(state.bookedFor?.kind === "member" ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("book_for_guest")
      .setLabel(state.bookedFor?.kind === "guest" ? `For ${forLabel(state, false)}`.slice(0, 80) : "For a guest...")
      .setStyle(state.bookedFor?.kind === "guest" ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_back_duration")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("book_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  const header = buildSelectionHeader(state, product);
  const forNote = state.bookedFor
    ? `\n_You pay; ${forLabel(state)} gets the calendar invitation${getUserEmail(guildId, userId) ? " (you too)" : ""}._`
    : "";

  await updateMessage(interaction, {
    content: `${header}${forNote}\n👤 **Who is it for?**\n📝 **Event name:**`,
    components: [forRow, row, navRow],
  });
}

// Show payment method selection
async function showPaymentSelection(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  const state = bookStates.get(userId);
  if (!state || !state.name || !state.duration || !state.productSlug) {
    const errorMsg = { content: "⚠️ Session expired. Please run /book again.", components: [] };
    if (interaction.isButton()) {
      await updateMessage(interaction, errorMsg);
    } else if (interaction.isModalSubmit()) {
      await interaction.editReply(errorMsg);
    }
    return;
  }

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === state.productSlug);

  if (!product || !product.price || product.price.length === 0) {
    const errorMsg = { content: "⚠️ No payment options configured for this room.", components: [] };
    if (interaction.isButton()) {
      await updateMessage(interaction, errorMsg);
    } else if (interaction.isModalSubmit()) {
      await interaction.editReply(errorMsg);
    }
    return;
  }

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings || guildSettings.tokens.length === 0) {
    const errorMsg = { content: "⚠️ No tokens configured.", components: [] };
    if (interaction.isButton()) {
      await updateMessage(interaction, errorMsg);
    } else if (interaction.isModalSubmit()) {
      await interaction.editReply(errorMsg);
    }
    return;
  }

  // If only one payment option, skip to confirmation
  if (product.price.length === 1) {
    state.selectedToken = product.price[0].token;
    state.step = "confirm";
    bookStates.set(userId, state);
    await showConfirmation(interaction, userId, guildId);
    return;
  }

  const hours = state.duration / 60;
  const dateCount = state.selectedDates?.length || 1;
  const header = buildSelectionHeader(state, product);

  // Build payment option buttons
  const paymentButtons: ButtonBuilder[] = [];
  for (const price of product.price) {
    const totalPrice = (price.amount * hours * dateCount).toFixed(2);
    // Check if this token is configured in guild settings
    const tokenConfig = guildSettings.tokens.find(
      (t) => t.symbol.toLowerCase() === price.token.toLowerCase()
    );
    
    if (tokenConfig) {
      paymentButtons.push(
        new ButtonBuilder()
          .setCustomId(`book_pay_${price.token}`)
          .setLabel(`Pay ${totalPrice} ${price.token}`)
          .setStyle(ButtonStyle.Primary)
      );
    }
  }

  if (paymentButtons.length === 0) {
    const errorMsg = { content: "⚠️ No valid payment tokens configured.", components: [] };
    if (interaction.isButton()) {
      await updateMessage(interaction, errorMsg);
    } else if (interaction.isModalSubmit()) {
      await interaction.editReply(errorMsg);
    }
    return;
  }

  // If only one valid payment option after filtering, skip to confirmation
  if (paymentButtons.length === 1) {
    const tokenSymbol = product.price.find((p) => 
      guildSettings.tokens.some((t) => t.symbol.toLowerCase() === p.token.toLowerCase())
    )?.token;
    if (tokenSymbol) {
      state.selectedToken = tokenSymbol;
      state.step = "confirm";
      bookStates.set(userId, state);
      await showConfirmation(interaction, userId, guildId);
      return;
    }
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...paymentButtons.slice(0, 5));

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_back_duration")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("book_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  const updateContent = {
    content: `${header}\n💳 **Choose payment method:**`,
    components: [row, navRow],
  };

  if (interaction.isButton()) {
    await updateMessage(interaction, updateContent);
  } else if (interaction.isModalSubmit()) {
    await interaction.editReply(updateContent);
  }
}

// Show confirmation UI
async function showConfirmation(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  const state = bookStates.get(userId);
  if (!state || !state.selectedDate || state.selectedHour === undefined || state.selectedMinute === undefined || !state.duration) {
    const errorMsg = { content: "⚠️ Session expired. Please run /book again.", components: [] };
    if (interaction.isButton()) await updateMessage(interaction, errorMsg);
    else if (interaction.isModalSubmit()) await interaction.editReply(errorMsg);
    return;
  }

  if (state.selectedDates && state.selectedDates.length > 1) {
    await showMultiDateConfirmation(interaction, userId, guildId);
    return;
  }

  // Build start and end times
  const startTime = new Date(state.selectedDate);
  startTime.setHours(state.selectedHour, state.selectedMinute, 0, 0);
  
  const endTime = new Date(startTime.getTime() + state.duration * 60000);

  state.startTime = startTime;
  state.endTime = endTime;
  state.step = "confirm";
  bookStates.set(userId, state);

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === state.productSlug);

  if (!product) {
    const errorMsg = { content: "⚠️ Product not found.", components: [] };
    if (interaction.isButton()) await updateMessage(interaction, errorMsg);
    else if (interaction.isModalSubmit()) await interaction.editReply(errorMsg);
    return;
  }

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    const errorMsg = { content: "⚠️ Guild settings not found.", components: [] };
    if (interaction.isButton()) await updateMessage(interaction, errorMsg);
    else if (interaction.isModalSubmit()) await interaction.editReply(errorMsg);
    return;
  }

  // Find the selected token and price
  const selectedTokenSymbol = state.selectedToken || product.price[0].token;
  const selectedPrice = product.price.find(
    (p) => p.token.toLowerCase() === selectedTokenSymbol.toLowerCase()
  ) || product.price[0];
  const tokenConfig = guildSettings.tokens.find(
    (t) => t.symbol.toLowerCase() === selectedTokenSymbol.toLowerCase()
  );

  if (!tokenConfig) {
    const errorMsg = { content: "⚠️ Token configuration not found.", components: [] };
    if (interaction.isButton()) await updateMessage(interaction, errorMsg);
    else if (interaction.isModalSubmit()) await interaction.editReply(errorMsg);
    return;
  }

  // Calculate price
  const hours = state.duration / 60;
  const priceAmount = selectedPrice.amount * hours;
  const tokenSymbol = tokenConfig.symbol;

  // Get user's balance
  const userAddress = await getCachedAddress(userId);
  const balance = await getBalance(
    tokenConfig.chain as SupportedChain,
    tokenConfig.address,
    userAddress,
  );
  const balanceFormatted = parseFloat(
    formatUnits(balance, tokenConfig.decimals),
  ).toFixed(2);
  const requiredAmount = parseUnits(
    priceAmount.toString(),
    tokenConfig.decimals,
  );
  const hasEnoughBalance = balance >= requiredAmount;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_confirm")
      .setLabel(`Pay ${priceAmount.toFixed(2)} ${tokenSymbol} to confirm`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasEnoughBalance),
    new ButtonBuilder()
      .setCustomId("book_back_payment")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("book_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  const startDateStr = formatDiscordDate(startTime);
  const startTimeStr = formatDiscordTime(startTime);
  const endTimeStr = formatDiscordTime(endTime);

  let content = `📋 **Booking Summary**

**Event:** ${state.name}${state.bookedFor ? `\n**For:** ${forLabel(state)} (you pay)` : ""}
**Room:** ${product.name}
**When:** ${startDateStr} at ${startTimeStr}
**Until:** ${endTimeStr}
**Duration:** ${formatDuration(state.duration)}
**Price:** ${priceAmount.toFixed(2)} ${tokenSymbol}

**Your balance:** ${balanceFormatted} ${tokenSymbol}`;

  if (!hasEnoughBalance) {
    const mintInstructions = tokenConfig.mintInstructions || "";
    content += `\n\n⚠️ **Insufficient balance**\nYou need ${priceAmount.toFixed(2)} ${tokenSymbol} but only have ${balanceFormatted} ${tokenSymbol}.\n\n${mintInstructions}`;
  }

  if (interaction.isButton()) {
    await updateMessage(interaction, { content, components: [row] });
  } else if (interaction.isModalSubmit()) {
    await interaction.editReply({ content, components: [row] });
  }
}

// Process the final booking
async function processBooking(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton()) return;

  const state = bookStates.get(userId);
  if (state?.selectedDates && state.selectedDates.length > 1) {
    await processMultiDateBooking(interaction, userId, guildId);
    return;
  }

  if (!state || !state.productSlug || !state.startTime || !state.endTime) {
    await updateMessage(interaction, {
      content: "⚠️ Session expired. Please run /book again.",
      components: [],
    });
    return;
  }

  await updateMessage(interaction, {
    content: "⏳ Processing payment...",
    components: [],
  });

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === state.productSlug);

  if (!product?.calendarId) {
    await interaction.editReply({
      content: "⚠️ This room doesn't have a calendar configured.",
    });
    return;
  }

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.editReply({
      content: "⚠️ Guild settings not found. Please contact an administrator.",
    });
    return;
  }

  const calendarUrl = `https://calendar.google.com/calendar/embed?src=${
    encodeURIComponent(product.calendarId!)
  }&ctz=${encodeURIComponent(guildSettings.guild.timezone || "Europe/Brussels")}`;

  // Find the selected token and price
  const selectedTokenSymbol = state.selectedToken || product.price[0].token;
  const selectedPrice = product.price.find(
    (p) => p.token.toLowerCase() === selectedTokenSymbol.toLowerCase()
  ) || product.price[0];
  const tokenConfig = guildSettings.tokens.find(
    (t) => t.symbol.toLowerCase() === selectedTokenSymbol.toLowerCase()
  );

  if (!tokenConfig) {
    console.error(`Token config not found for ${selectedTokenSymbol}`);
    console.error("Available tokens:", guildSettings.tokens.map(t => t.symbol));
    await interaction.editReply({
      content: `⚠️ Token configuration not found for ${selectedTokenSymbol}.\nAvailable: ${guildSettings.tokens.map(t => t.symbol).join(", ")}`,
    });
    return;
  }

  const hours = (state.duration || 60) / 60;
  const priceAmount = selectedPrice.amount * hours;
  const tokenSymbol = tokenConfig.symbol;

  console.log(`Processing payment: ${priceAmount} ${tokenSymbol} on ${tokenConfig.chain}`);

  try {
    const userAddress = await getCachedAddress(userId);

    const balance = await getBalance(
      tokenConfig.chain as SupportedChain,
      tokenConfig.address,
      userAddress,
    );

    const requiredAmount = parseUnits(
      priceAmount.toString(),
      tokenConfig.decimals,
    );

    if (balance < requiredAmount) {
      const balanceFormatted = parseFloat(
        formatUnits(balance, tokenConfig.decimals),
      ).toFixed(2);
      const mintInstructions = tokenConfig.mintInstructions || "";

      await interaction.editReply({
        content: `❌ **Insufficient balance**

**Balance:** ${balanceFormatted} ${tokenSymbol}
**Required:** ${priceAmount.toFixed(2)} ${tokenSymbol}

${mintInstructions}`,
      });
      return;
    }

    const txHash = await burnTokensFrom(
      tokenConfig.chain as SupportedChain,
      tokenConfig.address,
      userAddress,
      priceAmount.toString(),
      tokenConfig.decimals,
    );

    if (!txHash) {
      await interaction.editReply({
        content: "❌ Payment failed. Transaction returned no hash.",
      });
      return;
    }

    const bookingTime = new Date();
    const bookingDateStr = formatDiscordDate(bookingTime);
    const bookingTimeStr = formatDiscordTime(bookingTime);

    try {
      const calendarClient = new GoogleCalendarClient();

      await calendarClient.ensureCalendarInList(product.calendarId);

      const chainId = tokenConfig.chain === "celo" ? 42220 : 
                      tokenConfig.chain === "gnosis" ? 100 : 84532;
      const explorerBaseUrl = tokenConfig.chain === "celo"
        ? "https://celoscan.io"
        : tokenConfig.chain === "gnosis" 
        ? "https://gnosisscan.io"
        : "https://sepolia.basescan.org";
      const txUrl = `${explorerBaseUrl}/tx/${txHash}`;

      let transactionMessageLink = "";
      if (guildSettings.channels?.transactions && interaction.guild) {
        try {
          const transactionsChannel = await interaction.guild.channels.fetch(
            guildSettings.channels.transactions,
          ) as TextChannel;

          if (transactionsChannel) {
            const dateStr = formatDiscordDate(state.startTime);
            const startTimeStr = formatDiscordTime(state.startTime);
            const endTimeStr = formatDiscordTime(state.endTime);

            const message = await transactionsChannel.send(
              `🗓️ <@${userId}> booked ${product.name}${state.bookedFor ? ` for ${forLabel(state)}` : ""} on ${dateStr} from ${startTimeStr} till ${endTimeStr} for ${
                priceAmount.toFixed(2)
              } ${tokenSymbol} [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`,
            );

            transactionMessageLink =
              `https://discord.com/channels/${guildId}/${guildSettings.channels.transactions}/${message.id}`;
          }
        } catch (error) {
          console.error("Error sending message to transactions channel:", error);
        }
      }

      let eventDescription =
        `Booked by ${interaction.user.displayName} (@${interaction.user.username})${state.bookedFor ? ` on behalf of ${forLabel(state, false)}` : ""} on ${bookingDateStr} at ${bookingTimeStr} for ${
          priceAmount.toFixed(2)
        } ${tokenSymbol}`;
      if (transactionMessageLink) {
        eventDescription += `\n${transactionMessageLink}`;
      }
      if (state.eventUrl) {
        eventDescription += `\nEvent URL: ${state.eventUrl}`;
      }
      eventDescription +=
        `\n\nPlease reach out to @${interaction.user.username} on Discord for questions about this booking.
        \n\nTo cancel, ${interaction.user.displayName} needs to run the /cancel command in Discord.
        \n\nUser ID: ${userId}
Booking TX: ${txHash}
Booking Chain: ${tokenConfig.chain}`;

      const calendarEvent: any = {
        summary: state.name || "Room Booking",
        description: eventDescription,
        start: {
          dateTime: state.startTime.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        end: {
          dateTime: state.endTime.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      };

      if (state.eventUrl) {
        calendarEvent.source = { url: state.eventUrl, title: "Event page" };
      }

      const invite = await createBookingEvent(product.calendarId, calendarEvent, inviteEmails(state, guildId, userId));

      // Invalidate room events cache so /shifts and /book show updated data
      invalidateRoomEventsCache();

      try {
        const nostr = Nostr.getInstance();
        const txUri = `ethereum:${chainId}:tx:${txHash}` as URI;
        const durationStr = formatDuration(state.duration || 60);

        await nostr.publishMetadata(txUri, {
          content: `Booking ${product.name} room for ${durationStr}`,
          tags: [
            ["t", "booking"],
            ["t", product.slug],
          ],
        });
      } catch (error) {
        console.error("Error sending Nostr annotation:", error);
      }

      if (product.channelId && interaction.guild) {
        try {
          const roomChannel = await interaction.guild.channels.fetch(
            product.channelId,
          ) as TextChannel;

          if (roomChannel) {
            const dateStr = formatDiscordDate(state.startTime);
            const startTimeStr = formatDiscordTime(state.startTime);
            const endTimeStr = formatDiscordTime(state.endTime);

            await roomChannel.send(
              `🗓️ <@${userId}> booked ${product.name}${state.bookedFor ? ` for ${forLabel(state)}` : ""} on ${dateStr} from ${startTimeStr} till ${endTimeStr} for ${
                priceAmount.toFixed(2)
              } ${tokenSymbol} [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`,
            );
          }
        } catch (error) {
          console.error("Error sending message to room channel:", error);
        }
      }

      const mailNote = await emailGuest(state, interaction, guildId, userId, product, [{ start: state.startTime, end: state.endTime, eventId: invite.eventId }], priceAmount, tokenSymbol, txUrl, txHash);

      bookStates.delete(userId);

      await interaction.editReply({
        content: `✅ **Booking Confirmed!**

**Event:** ${state.name}${state.bookedFor ? `\n**For:** ${forLabel(state)}` : ""}
**Room:** ${product.name}
**Start:** ${state.startTime.toLocaleString()}
**End:** ${state.endTime.toLocaleString()}
**Paid:** ${priceAmount.toFixed(2)} ${tokenSymbol}${state.eventUrl ? `\n**URL:** ${state.eventUrl}` : ""}

${inviteNote(state, invite)}${mailNote}[View transaction](<${txUrl}>)

You can view the calendar of all bookings for the ${product.name} room on its [public calendar](<${calendarUrl}>).`,
      });
    } catch (error: any) {
      console.error("Error creating calendar event:", error);
      console.error("Error details:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

      let errorMessage = `❌ Payment successful but booking failed.\n\n**Error:** ${error.message || "Unknown error"}`;
      if (error.conflictingEvent) {
        const conflictStart = new Date(error.conflictingEvent.start.dateTime);
        const conflictEnd = new Date(error.conflictingEvent.end.dateTime);
        const conflictDuration = Math.round(
          (conflictEnd.getTime() - conflictStart.getTime()) / 60000,
        );

        errorMessage = `❌ **Payment successful but booking conflict detected!**

There's already an event at this time:

**Event:** ${error.conflictingEvent.summary}
**Start:** ${conflictStart.toLocaleString()}
**End:** ${conflictEnd.toLocaleString()}
**Duration:** ${conflictDuration} minutes

Your payment of ${priceAmount.toFixed(2)} ${tokenSymbol} has been processed.
Please contact an administrator for a refund.`;
      }

      await interaction.editReply({
        content: errorMessage,
      });
    }
  } catch (error: any) {
    console.error("Error processing payment:", error);
    console.error("Token config:", JSON.stringify(tokenConfig, null, 2));
    console.error("Price amount:", priceAmount);
    console.error("User ID:", userId);

    const rawMsg: string = error.message || "Unknown error";
    let userMessage: string;

    if (rawMsg.includes("Nonce provided") && rawMsg.includes("lower than the current nonce")) {
      userMessage = `❌ **Payment failed — please try again**

The transaction hit a temporary conflict (another transaction was processing at the same time). This is not a problem with your account or balance.

**What to do:** Simply run \`/book\` again. Your tokens have **not** been deducted.`;
    } else if (rawMsg.includes("Insufficient balance") || rawMsg.includes("insufficient funds")) {
      userMessage = `❌ **Insufficient balance**

You don't have enough ${tokenSymbol} to complete this payment.

• **Required:** ${priceAmount.toFixed(2)} ${tokenSymbol}
• **Token:** ${tokenSymbol} (${tokenConfig.chain})

${tokenConfig.mintInstructions || ""}`;
    } else if (rawMsg.includes("allowance") || rawMsg.includes("ERC20: burn amount exceeds allowance")) {
      userMessage = `❌ **Payment failed — approval needed**

The bot doesn't have permission to burn tokens from your account. Please contact an administrator to set up the token allowance.`;
    } else {
      userMessage = `❌ **Payment failed**

Something went wrong processing your payment. Please try again in a moment.

If the problem persists, contact an administrator with this info:
• Token: ${tokenSymbol} (${tokenConfig.chain})
• Amount: ${priceAmount.toFixed(2)}
• Error: ${rawMsg.length > 200 ? rawMsg.slice(0, 200) + "..." : rawMsg}`;
    }

    await interaction.editReply({ content: userMessage });
  }
}

// ── Several dates, same time and duration ──────────────────────────────────

interface CheckedOccurrence extends Occurrence {
  conflict?: { summary?: string | null; start: { dateTime?: string | null }; end: { dateTime?: string | null } };
}

/** Look up every occurrence in the room's calendar; a clash is reported, never booked. */
async function checkOccurrences(calendarId: string, occurrences: Occurrence[]): Promise<CheckedOccurrence[]> {
  const calendar = new GoogleCalendarClient();
  const out: CheckedOccurrence[] = [];
  for (const occurrence of occurrences) {
    const dayStart = new Date(occurrence.start);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(occurrence.start);
    dayEnd.setHours(23, 59, 59, 999);
    const events = await calendar.listEvents(calendarId, dayStart, dayEnd);
    out.push({ ...occurrence, conflict: findConflict(occurrence, events) });
  }
  return out;
}

function stateOccurrences(state: BookState): Occurrence[] {
  const dates = state.selectedDates && state.selectedDates.length > 0 ? state.selectedDates : [state.selectedDate!];
  return occurrencesFor(dates, state.selectedHour!, state.selectedMinute!, state.duration!);
}

function occurrenceLine(o: CheckedOccurrence): string {
  const when = `${formatShortDate(o.start)} ${formatDiscordTime(o.start)}–${formatDiscordTime(o.end)}`;
  return o.conflict ? `❌ ${when} — already booked (${o.conflict.summary || "busy"})` : `✅ ${when}`;
}

async function showMultiDateConfirmation(interaction: Interaction, userId: string, guildId: string) {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;
  const reply = async (data: { content: string; components: any[] }) => {
    if (interaction.isButton()) await updateMessage(interaction, data);
    else if (interaction.isModalSubmit()) await interaction.editReply(data);
  };

  const state = bookStates.get(userId);
  if (!state || !state.selectedDates || state.selectedHour === undefined || state.selectedMinute === undefined || !state.duration) {
    await reply({ content: "⚠️ Session expired. Please run /book again.", components: [] });
    return;
  }

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === state.productSlug);
  const guildSettings = await loadGuildSettings(guildId);
  if (!product?.calendarId || !guildSettings) {
    await reply({ content: "⚠️ This room or the guild settings are not configured.", components: [] });
    return;
  }
  const selectedTokenSymbol = state.selectedToken || product.price[0].token;
  const selectedPrice = product.price.find((p) => p.token.toLowerCase() === selectedTokenSymbol.toLowerCase()) || product.price[0];
  const tokenConfig = guildSettings.tokens.find((t) => t.symbol.toLowerCase() === selectedTokenSymbol.toLowerCase());
  if (!tokenConfig) {
    await reply({ content: "⚠️ Token configuration not found.", components: [] });
    return;
  }

  const checked = await checkOccurrences(product.calendarId, stateOccurrences(state));
  const free = checked.filter((o) => !o.conflict);
  state.startTime = free[0]?.start ?? checked[0].start;
  state.endTime = free[0]?.end ?? checked[0].end;
  state.step = "confirm";
  bookStates.set(userId, state);

  const perBooking = selectedPrice.amount * (state.duration / 60);
  const total = perBooking * free.length;
  const tokenSymbol = tokenConfig.symbol;
  const userAddress = await getCachedAddress(userId);
  const balance = await getBalance(tokenConfig.chain as SupportedChain, tokenConfig.address, userAddress);
  const balanceFormatted = parseFloat(formatUnits(balance, tokenConfig.decimals)).toFixed(2);
  const hasEnoughBalance = free.length > 0 && balance >= parseUnits(total.toFixed(tokenConfig.decimals > 6 ? 6 : tokenConfig.decimals), tokenConfig.decimals);

  let content = `📋 **Booking Summary — ${checked.length} dates**

**Event:** ${state.name}${state.bookedFor ? `\n**For:** ${forLabel(state)} (you pay)` : ""}
**Room:** ${product.name}
**Duration:** ${formatDuration(state.duration)} each
${checked.map(occurrenceLine).join("\n")}

**Price:** ${free.length} × ${perBooking.toFixed(2)} = ${total.toFixed(2)} ${tokenSymbol}
**Your balance:** ${balanceFormatted} ${tokenSymbol}`;

  if (free.length === 0) {
    content += `\n\n⚠️ The room is already booked at that time on every date. Go back and pick another time.`;
  } else if (free.length < checked.length) {
    content += `\n\nOnly the ✅ dates will be booked and paid for.`;
  }
  if (free.length > 0 && !hasEnoughBalance) {
    content += `\n\n⚠️ **Insufficient balance**\nYou need ${total.toFixed(2)} ${tokenSymbol} but only have ${balanceFormatted} ${tokenSymbol}.\n\n${tokenConfig.mintInstructions || ""}`;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("book_confirm")
      .setLabel(free.length ? `Pay ${total.toFixed(2)} ${tokenSymbol} to book ${free.length} date${free.length > 1 ? "s" : ""}` : "Nothing to book")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasEnoughBalance),
    new ButtonBuilder().setCustomId("book_back_payment").setLabel("← Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("book_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );
  await reply({ content, components: [row] });
}

async function processMultiDateBooking(interaction: Interaction, userId: string, guildId: string) {
  if (!interaction.isButton()) return;
  const state = bookStates.get(userId);
  if (!state || !state.productSlug || !state.selectedDates || state.selectedHour === undefined || state.selectedMinute === undefined || !state.duration) {
    await updateMessage(interaction, { content: "⚠️ Session expired. Please run /book again.", components: [] });
    return;
  }
  await updateMessage(interaction, { content: "⏳ Checking the dates and processing payment...", components: [] });

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === state.productSlug);
  const guildSettings = await loadGuildSettings(guildId);
  if (!product?.calendarId || !guildSettings) {
    await interaction.editReply({ content: "⚠️ This room or the guild settings are not configured." });
    return;
  }
  const selectedTokenSymbol = state.selectedToken || product.price[0].token;
  const selectedPrice = product.price.find((p) => p.token.toLowerCase() === selectedTokenSymbol.toLowerCase()) || product.price[0];
  const tokenConfig = guildSettings.tokens.find((t) => t.symbol.toLowerCase() === selectedTokenSymbol.toLowerCase());
  if (!tokenConfig) {
    await interaction.editReply({ content: `⚠️ Token configuration not found for ${selectedTokenSymbol}.` });
    return;
  }
  const tokenSymbol = tokenConfig.symbol;
  const calendarUrl = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(product.calendarId)}&ctz=${encodeURIComponent(guildSettings.guild.timezone || "Europe/Brussels")}`;

  // Re-check right before paying: someone may have booked a date since the summary.
  const checked = await checkOccurrences(product.calendarId, stateOccurrences(state));
  const free = checked.filter((o) => !o.conflict);
  if (free.length === 0) {
    await interaction.editReply({ content: `❌ Nothing booked, nothing paid: the room is already booked at that time on every date.\n\n${checked.map(occurrenceLine).join("\n")}` });
    return;
  }

  const perBooking = selectedPrice.amount * (state.duration / 60);
  const total = perBooking * free.length;
  const amount = total.toFixed(tokenConfig.decimals > 6 ? 6 : tokenConfig.decimals);
  console.log(`Processing multi-date payment: ${amount} ${tokenSymbol} for ${free.length} dates on ${tokenConfig.chain}`);

  let txHash: string | null | undefined;
  try {
    const userAddress = await getCachedAddress(userId);
    const balance = await getBalance(tokenConfig.chain as SupportedChain, tokenConfig.address, userAddress);
    if (balance < parseUnits(amount, tokenConfig.decimals)) {
      const balanceFormatted = parseFloat(formatUnits(balance, tokenConfig.decimals)).toFixed(2);
      await interaction.editReply({ content: `❌ **Insufficient balance**\n\n**Balance:** ${balanceFormatted} ${tokenSymbol}\n**Required:** ${total.toFixed(2)} ${tokenSymbol}\n\n${tokenConfig.mintInstructions || ""}` });
      return;
    }
    txHash = await burnTokensFrom(tokenConfig.chain as SupportedChain, tokenConfig.address, userAddress, amount, tokenConfig.decimals);
  } catch (error: any) {
    console.error("Error processing multi-date payment:", error);
    const rawMsg: string = error?.message || "Unknown error";
    await interaction.editReply({ content: `❌ **Payment failed, nothing was booked.**\n\nPlease try again in a moment. If it persists, contact an administrator.\n• Error: ${rawMsg.length > 200 ? rawMsg.slice(0, 200) + "..." : rawMsg}` });
    return;
  }
  if (!txHash) {
    await interaction.editReply({ content: "❌ Payment failed. Transaction returned no hash. Nothing was booked." });
    return;
  }

  const explorerBaseUrl = tokenConfig.chain === "celo" ? "https://celoscan.io" : tokenConfig.chain === "gnosis" ? "https://gnosisscan.io" : "https://sepolia.basescan.org";
  const chainId = tokenConfig.chain === "celo" ? 42220 : tokenConfig.chain === "gnosis" ? 100 : 84532;
  const txUrl = `${explorerBaseUrl}/tx/${txHash}`;
  const bookingTime = new Date();
  const calendarClient = new GoogleCalendarClient();
  await calendarClient.ensureCalendarInList(product.calendarId).catch((e) => console.error("ensureCalendarInList:", e));

  const booked: (Occurrence & { eventId?: string })[] = [];
  const failed: { occurrence: Occurrence; reason: string }[] = [];
  const invitees = inviteEmails(state, guildId, userId);
  let invite: { invited: boolean; inviteError?: string; eventId?: string } = { invited: false };
  for (const [i, occurrence] of free.entries()) {
    let description = `Booked by ${interaction.user.displayName} (@${interaction.user.username})${state.bookedFor ? ` on behalf of ${forLabel(state, false)}` : ""} on ${formatDiscordDate(bookingTime)} at ${formatDiscordTime(bookingTime)}, date ${i + 1} of ${free.length} in one booking, ${total.toFixed(2)} ${tokenSymbol} in total (${perBooking.toFixed(2)} for this date)`;
    if (state.eventUrl) description += `\nEvent URL: ${state.eventUrl}`;
    description += `\n\nPlease reach out to @${interaction.user.username} on Discord for questions about this booking.\n\nTo cancel, ${interaction.user.displayName} needs to run the /cancel command in Discord.\n\nUser ID: ${userId}\nBooking TX: ${txHash}\nBooking Chain: ${tokenConfig.chain}`;
    const event: any = {
      summary: state.name || "Room Booking",
      description,
      start: { dateTime: occurrence.start.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      end: { dateTime: occurrence.end.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    };
    if (state.eventUrl) event.source = { url: state.eventUrl, title: "Event page" };
    try {
      invite = await createBookingEvent(product.calendarId, event, invitees);
      booked.push({ ...occurrence, eventId: invite.eventId });
    } catch (error: any) {
      console.error(`Error creating calendar event for ${occurrence.start.toISOString()}:`, error);
      failed.push({ occurrence, reason: error?.conflictingEvent ? `taken meanwhile by "${error.conflictingEvent.summary}"` : (error?.message || "unknown error") });
    }
  }
  invalidateRoomEventsCache();

  const whenList = booked.map((o) => `${formatDiscordDate(o.start)} ${formatDiscordTime(o.start)}–${formatDiscordTime(o.end)}`).join(", ");
  const announcement = `🗓️ <@${userId}> booked ${product.name}${state.bookedFor ? ` for ${forLabel(state)}` : ""} on ${booked.length} date${booked.length > 1 ? "s" : ""} (${whenList}) for ${total.toFixed(2)} ${tokenSymbol} [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`;
  for (const channelId of [guildSettings.channels?.transactions, product.channelId]) {
    if (!channelId || !interaction.guild || booked.length === 0) continue;
    try {
      const channel = await interaction.guild.channels.fetch(channelId) as TextChannel;
      await channel?.send(announcement);
    } catch (error) {
      console.error(`Error sending booking message to channel ${channelId}:`, error);
    }
  }

  try {
    await Nostr.getInstance().publishMetadata(`ethereum:${chainId}:tx:${txHash}` as URI, {
      content: `Booking ${product.name} room for ${booked.length} × ${formatDuration(state.duration)}`,
      tags: [["t", "booking"], ["t", product.slug]],
    });
  } catch (error) {
    console.error("Error sending Nostr annotation:", error);
  }

  const mailNote = await emailGuest(state, interaction, guildId, userId, product, booked, perBooking * booked.length, tokenSymbol, txUrl, txHash);
  bookStates.delete(userId);
  const skipped = checked.filter((o) => o.conflict);
  let content = booked.length > 0 ? `✅ **Booked ${booked.length} date${booked.length > 1 ? "s" : ""}!**` : "❌ **Payment went through but no date could be booked.**";
  content += `\n\n**Event:** ${state.name}${state.bookedFor ? `\n**For:** ${forLabel(state)}` : ""}\n**Room:** ${product.name}\n${booked.map((o) => `✅ ${formatShortDate(o.start)} ${formatDiscordTime(o.start)}–${formatDiscordTime(o.end)}`).join("\n")}`;
  if (skipped.length) content += `\n${skipped.map(occurrenceLine).join("\n")}\n_Not booked and not charged._`;
  if (failed.length) {
    content += `\n${failed.map((f) => `⚠️ ${formatShortDate(f.occurrence.start)} — ${f.reason}`).join("\n")}`;
    content += `\n\n**${(perBooking * failed.length).toFixed(2)} ${tokenSymbol} was charged for ${failed.length === 1 ? "that date" : "those dates"} but it could not be booked. Please contact an administrator for a refund** (tx below).`;
  }
  content += `\n${inviteNote(state, invite)}${mailNote}**Paid:** ${total.toFixed(2)} ${tokenSymbol}${state.eventUrl ? `\n**URL:** ${state.eventUrl}` : ""}\n\n[View transaction](<${txUrl}>) · [${product.name} calendar](<${calendarUrl}>)`;
  await interaction.editReply({ content });
}

// Handle select menu interactions
export async function handleBookSelect(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) return;

  const customId = interaction.customId;
  const state = bookStates.get(userId);
  await ackClick(interaction);

  // Booking on behalf of another member
  if (customId === "book_for_member_select" && interaction.isUserSelectMenu()) {
    if (!state || !state.selectedDate || !state.duration) {
      await updateMessage(interaction, { content: "⚠️ Session expired. Please run /book again.", components: [] });
      return;
    }
    const memberId = interaction.values[0];
    const member = interaction.members?.get(memberId) as any;
    const user = interaction.users.get(memberId);
    if (!user || user.bot) {
      await updateMessage(interaction, { content: "⚠️ Please pick a person, not a bot.", components: [] });
      return;
    }
    if (memberId === userId) {
      state.bookedFor = undefined;
    } else {
      const known = getUser(guildId, memberId);
      const displayName = member?.nick || member?.displayName || user.globalName || user.username;
      state.bookedFor = { kind: "member", discordUserId: memberId, username: user.username, displayName, email: known?.email };
    }
    bookStates.set(userId, state);
    await showNameInput(interaction, userId, guildId);
    return;
  }

  if (!interaction.isStringSelectMenu()) return;

  if (!state) {
    await updateMessage(interaction, {
      content: "⚠️ Session expired. Please run /book again.",
      components: [],
    });
    return;
  }

  // Date selection from extended menu
  if (customId === "book_date_select") {
    const dateValue = interaction.values[0];
    const selectedDate = parseDateValue(dateValue);
    state.selectedDate = selectedDate;
    state.selectedDates = undefined;
    state.step = "time";
    bookStates.set(userId, state);

    await showTimeSelection(interaction, userId, guildId);
    return;
  }

  // Time selection
  if (customId === "book_time_select") {
    const timeValue = interaction.values[0];
    const [hour, minute] = timeValue.split(":").map(Number);
    
    state.selectedHour = hour;
    state.selectedMinute = minute;
    state.step = "duration";
    bookStates.set(userId, state);

    await showDurationSelection(interaction, userId, guildId);
    return;
  }
}

// Handle modal submissions
export async function handleBookModal(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isModalSubmit()) return;

  if (interaction.customId === "book_date_modal") {
    const state = bookStates.get(userId);
    if (!state) {
      await interaction.reply({
        content: "⚠️ Session expired. Please run /book again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const dateInput = interaction.fields.getTextInputValue("custom_date").trim();

    // One date, or several separated by commas (DD/MM/YYYY, DD-MM-YYYY or DD.MM.YYYY).
    const { dates, errors } = parseDateList(dateInput, getLocalToday());
    if (errors.length > 0 || dates.length === 0) {
      await interaction.reply({
        content: `❌ ${errors.length ? errors.join("\n❌ ") : "No date entered."}\n\nUse DD/MM/YYYY, and separate several dates with commas (e.g. 15/03/2026, 22/03/2026). At most ${MAX_BOOKING_DATES} dates.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const selectedDate = dates[0];
    state.selectedDates = dates.length > 1 ? dates : undefined;
    state.selectedDate = selectedDate;
    state.step = "time";
    bookStates.set(userId, state);

    await interaction.deferUpdate();
    await showTimeSelection(interaction, userId, guildId);
    return;
  }

  if (interaction.customId === "book_guest_modal") {
    const state = bookStates.get(userId);
    if (!state) {
      await interaction.reply({ content: "⚠️ Session expired. Please run /book again.", flags: MessageFlags.Ephemeral });
      return;
    }
    const name = interaction.fields.getTextInputValue("guest_name").trim();
    const email = interaction.fields.getTextInputValue("guest_email").trim().toLowerCase();
    let bookerEmail = "";
    try { bookerEmail = interaction.fields.getTextInputValue("booker_email").trim().toLowerCase(); } catch { /* already known */ }
    const problems: string[] = [];
    if (!name) problems.push("the guest name is empty");
    if (!EMAIL_RE.test(email)) problems.push(`"${email}" is not a valid email for the guest`);
    if (bookerEmail && !EMAIL_RE.test(bookerEmail)) problems.push(`"${bookerEmail}" is not a valid email for you`);
    if (problems.length) {
      await interaction.reply({ content: `❌ ${problems.join("; ")}. Click "For a guest..." again.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (bookerEmail) {
      await saveUser(guildId, {
        discordUserId: userId,
        username: interaction.user.username,
        displayName: interaction.user.displayName || interaction.user.username,
        email: bookerEmail,
      });
    }
    state.bookedFor = { kind: "guest", name, email };
    bookStates.set(userId, state);
    await interaction.deferUpdate();
    await showNameInput(interaction, userId, guildId);
    return;
  }

  if (interaction.customId === "book_name_modal") {
    const state = bookStates.get(userId);
    if (!state) {
      await interaction.reply({
        content: "⚠️ Session expired. Please run /book again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const eventName = interaction.fields.getTextInputValue("event_name");
    let eventUrl = "";
    try { eventUrl = interaction.fields.getTextInputValue("event_url").trim(); } catch { /* optional field */ }
    state.name = eventName;
    if (eventUrl) state.eventUrl = eventUrl;
    state.step = "payment";
    bookStates.set(userId, state);

    await interaction.deferUpdate();
    await showPaymentSelection(interaction, userId, guildId);
  }
}
