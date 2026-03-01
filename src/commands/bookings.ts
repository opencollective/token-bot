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
} from "discord.js";
import { CalendarEvent, GoogleCalendarClient } from "../lib/googlecalendar.ts";
import { loadGuildFile, loadGuildSettings } from "../lib/utils.ts";
import { Product } from "../types.ts";
import { disabledCalendars } from "../lib/calendar-state.ts";
import {
  burnTokensFrom,
  getBalance,
  getTokenAddressFromTx,
  mintTokens,
  SupportedChain,
} from "../lib/blockchain.ts";
import { getAccountAddressForToken } from "../lib/citizenwallet.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { formatUnits, parseUnits } from "@wevm/viem";

// ── Types ───────────────────────────────────────────────────────────────────

interface BookingInfo {
  event: CalendarEvent;
  calendarId: string;
  product: Product;
  pricePerHour: number;
  tokenSymbol: string;
  totalPrice: number;
  durationMinutes: number;
  bookingTx?: { txHash: string; chain: string };
  eventUrl?: string;
}

interface BookingsState {
  bookings: BookingInfo[];
  selectedIndex?: number;
  // Edit state
  editStep?: "menu" | "room" | "date" | "time" | "duration" | "url" | "confirm";
  newProductSlug?: string;
  newDate?: Date;
  newHour?: number;
  newMinute?: number;
  newDuration?: number;
  newUrl?: string;
}

export const bookingsStates = new Map<string, BookingsState>();

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}`;
}

function formatDiscordDate(date: Date): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const d = date.getDate();
  let suffix = "th";
  if (d === 1 || d === 21 || d === 31) suffix = "st";
  else if (d === 2 || d === 22) suffix = "nd";
  else if (d === 3 || d === 23) suffix = "rd";
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${d}${suffix}`;
}

function formatDiscordTime(date: Date): string {
  let h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m < 10 ? "0" : ""}${m}${ampm}`;
}

function formatShortDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[date.getDay()]} ${date.getDate()}/${date.getMonth() + 1}`;
}

function getLocalToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseBookingTx(desc?: string): { txHash: string; chain: string } | undefined {
  if (!desc) return undefined;
  const tx = desc.match(/Booking TX: (0x[a-fA-F0-9]+)/);
  const chain = desc.match(/Booking Chain: (\w+)/);
  return tx && chain ? { txHash: tx[1], chain: chain[1] } : undefined;
}

function parseEventUrl(desc?: string): string | undefined {
  if (!desc) return undefined;
  const m = desc.match(/Event URL: (.+)/);
  return m ? m[1].trim() : undefined;
}

function getExplorerUrl(chain: string, txHash: string): string {
  const base = chain === "celo" ? "https://celoscan.io" :
    chain === "gnosis" ? "https://gnosisscan.io" : "https://sepolia.basescan.org";
  return `${base}/tx/${txHash}`;
}

// ── Main Command ────────────────────────────────────────────────────────────

export async function handleBookingsCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const productsWithCalendar = products?.filter((p) => p.calendarId) || [];

    if (productsWithCalendar.length === 0) {
      await interaction.editReply({ content: "⚠️ No rooms with calendar integration found." });
      return;
    }

    const guildSettings = await loadGuildSettings(guildId);
    if (!guildSettings) {
      await interaction.editReply({ content: "⚠️ Guild settings not found." });
      return;
    }

    const calendarClient = new GoogleCalendarClient();
    const now = new Date();
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);

    const bookings: BookingInfo[] = [];
    const username = interaction.user.username;

    for (const product of productsWithCalendar) {
      try {
        await calendarClient.ensureCalendarInList(product.calendarId!);
        const events = await calendarClient.listEvents(product.calendarId!, now, futureDate);

        for (const event of events) {
          const matchesUserId = event.description?.includes(`User ID: ${userId}`);
          const matchesUsername = event.description?.includes(`@${username})`);

          if (matchesUserId || matchesUsername) {
            const start = new Date(event.start.dateTime);
            const end = new Date(event.end.dateTime);
            const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
            const hours = durationMinutes / 60;
            const bookingTx = parseBookingTx(event.description);
            const eventUrl = parseEventUrl(event.description);

            // Determine which token was used
            let tokenSymbol = product.price[0]?.token || guildSettings.tokens[0]?.symbol || "tokens";
            if (bookingTx) {
              try {
                const tokenAddress = await getTokenAddressFromTx(
                  bookingTx.chain as SupportedChain,
                  bookingTx.txHash,
                );
                if (tokenAddress) {
                  const token = guildSettings.tokens.find(
                    (t) => t.address.toLowerCase() === tokenAddress.toLowerCase(),
                  );
                  if (token) tokenSymbol = token.symbol;
                }
              } catch { /* use default */ }
            }

            const pricePerHour = product.price.find(
              (p) => p.token.toLowerCase() === tokenSymbol.toLowerCase(),
            )?.amount || product.price[0]?.amount || 0;

            bookings.push({
              event,
              calendarId: product.calendarId!,
              product,
              pricePerHour,
              tokenSymbol,
              totalPrice: pricePerHour * hours,
              durationMinutes,
              bookingTx,
              eventUrl,
            });
          }
        }
      } catch (error) {
        console.error(`Error fetching events for ${product.name}:`, error);
      }
    }

    if (bookings.length === 0) {
      await interaction.editReply({ content: "📅 You don't have any upcoming bookings." });
      return;
    }

    // Sort by start time
    bookings.sort((a, b) =>
      new Date(a.event.start.dateTime).getTime() - new Date(b.event.start.dateTime).getTime()
    );

    bookingsStates.set(userId, { bookings });

    // Build list
    let content = `📅 **Your Upcoming Bookings** (${bookings.length})\n\n`;
    for (let i = 0; i < bookings.length; i++) {
      const b = bookings[i];
      const start = new Date(b.event.start.dateTime);
      const end = new Date(b.event.end.dateTime);
      content += `**${i + 1}.** ${b.event.summary || "Booking"}\n`;
      content += `   📍 ${b.product.name} · ${formatDiscordDate(start)}\n`;
      content += `   ⏰ ${formatDiscordTime(start)} - ${formatDiscordTime(end)} (${formatDuration(b.durationMinutes)})\n`;
      content += `   💰 ${b.totalPrice.toFixed(2)} ${b.tokenSymbol}`;
      if (b.eventUrl) content += ` · [event link](<${b.eventUrl}>)`;
      content += `\n\n`;
    }

    // Build select menu
    const options = bookings.map((b, i) => {
      const start = new Date(b.event.start.dateTime);
      return {
        label: `${b.event.summary || "Booking"} - ${b.product.name}`,
        description: `${formatShortDate(start)} ${formatDiscordTime(start)} (${formatDuration(b.durationMinutes)})`,
        value: i.toString(),
      };
    }).slice(0, 25);

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("bookings_select")
        .setPlaceholder("Select a booking to edit or cancel...")
        .addOptions(options),
    );

    await interaction.editReply({ content, components: [selectRow] });
  } catch (error) {
    console.error("Error in bookings command:", error);
    await interaction.editReply({ content: "❌ An error occurred while fetching your bookings." });
  }
}

// ── Select Menu Handler ─────────────────────────────────────────────────────

export async function handleBookingsSelect(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isStringSelectMenu()) return;

  const state = bookingsStates.get(userId);
  if (!state) {
    await interaction.update({ content: "⚠️ Session expired. Run /bookings again.", components: [] });
    return;
  }

  if (interaction.customId === "bookings_select") {
    const idx = parseInt(interaction.values[0]);
    const booking = state.bookings[idx];
    if (!booking) {
      await interaction.update({ content: "⚠️ Invalid selection.", components: [] });
      return;
    }

    state.selectedIndex = idx;
    bookingsStates.set(userId, state);

    await showBookingActions(interaction, booking, idx);
    return;
  }

  // Edit: room selection
  if (interaction.customId === "bookings_edit_room_select") {
    const newSlug = interaction.values[0];
    state.newProductSlug = newSlug;
    state.editStep = "confirm";
    bookingsStates.set(userId, state);

    await showEditConfirmation(interaction, userId, guildId);
    return;
  }

  // Edit: date selection (extended)
  if (interaction.customId === "bookings_edit_date_select") {
    const [year, month, day] = interaction.values[0].split("-").map(Number);
    state.newDate = new Date(year, month - 1, day);
    state.editStep = "confirm";
    bookingsStates.set(userId, state);

    await showEditConfirmation(interaction, userId, guildId);
    return;
  }

  // Edit: time selection
  if (interaction.customId === "bookings_edit_time_select") {
    const [h, m] = interaction.values[0].split(":").map(Number);
    state.newHour = h;
    state.newMinute = m;
    state.editStep = "confirm";
    bookingsStates.set(userId, state);

    await showEditConfirmation(interaction, userId, guildId);
    return;
  }
}

// ── Show booking detail with Edit/Cancel ────────────────────────────────────

async function showBookingActions(
  interaction: Interaction,
  booking: BookingInfo,
  idx: number,
) {
  if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;

  const start = new Date(booking.event.start.dateTime);
  const end = new Date(booking.event.end.dateTime);
  const now = new Date();
  const hoursUntil = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
  const lateNotice = hoursUntil <= 24;

  let content = `📋 **Booking Details**\n\n`;
  content += `**Event:** ${booking.event.summary || "Booking"}\n`;
  content += `**Room:** ${booking.product.name}\n`;
  content += `**Date:** ${formatDiscordDate(start)}\n`;
  content += `**Time:** ${formatDiscordTime(start)} - ${formatDiscordTime(end)}\n`;
  content += `**Duration:** ${formatDuration(booking.durationMinutes)}\n`;
  content += `**Price:** ${booking.totalPrice.toFixed(2)} ${booking.tokenSymbol}\n`;
  if (booking.eventUrl) content += `**Event URL:** ${booking.eventUrl}\n`;
  if (lateNotice) {
    content += `\n⚠️ Less than 24h before event — refunds are 50%`;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`bookings_edit_${idx}`)
      .setLabel("✏️ Edit")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`bookings_cancel_${idx}`)
      .setLabel("❌ Cancel")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("bookings_back_list")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
  );

  if (interaction.isStringSelectMenu()) {
    await interaction.update({ content, components: [row] });
  } else {
    await interaction.update({ content, components: [row] });
  }
}

// ── Button Handler ──────────────────────────────────────────────────────────

export async function handleBookingsButton(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  const state = bookingsStates.get(userId);

  if (!state) {
    await interaction.update({ content: "⚠️ Session expired. Run /bookings again.", components: [] });
    return;
  }

  // Back to list
  if (customId === "bookings_back_list") {
    // Re-run the bookings list display
    let content = `📅 **Your Upcoming Bookings** (${state.bookings.length})\n\n`;
    for (let i = 0; i < state.bookings.length; i++) {
      const b = state.bookings[i];
      const start = new Date(b.event.start.dateTime);
      const end = new Date(b.event.end.dateTime);
      content += `**${i + 1}.** ${b.event.summary || "Booking"}\n`;
      content += `   📍 ${b.product.name} · ${formatDiscordDate(start)}\n`;
      content += `   ⏰ ${formatDiscordTime(start)} - ${formatDiscordTime(end)} (${formatDuration(b.durationMinutes)})\n`;
      content += `   💰 ${b.totalPrice.toFixed(2)} ${b.tokenSymbol}`;
      if (b.eventUrl) content += ` · [event link](<${b.eventUrl}>)`;
      content += `\n\n`;
    }

    const options = state.bookings.map((b, i) => {
      const start = new Date(b.event.start.dateTime);
      return {
        label: `${b.event.summary || "Booking"} - ${b.product.name}`,
        description: `${formatShortDate(start)} ${formatDiscordTime(start)} (${formatDuration(b.durationMinutes)})`,
        value: i.toString(),
      };
    }).slice(0, 25);

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("bookings_select")
        .setPlaceholder("Select a booking to edit or cancel...")
        .addOptions(options),
    );

    await interaction.update({ content, components: [selectRow] });
    return;
  }

  // ── Cancel booking ──────────────────────────────────────────────────────

  if (customId.startsWith("bookings_cancel_")) {
    const idx = parseInt(customId.replace("bookings_cancel_", ""));
    const booking = state.bookings[idx];
    if (!booking) {
      await interaction.update({ content: "⚠️ Invalid booking.", components: [] });
      return;
    }

    state.selectedIndex = idx;
    bookingsStates.set(userId, state);

    const start = new Date(booking.event.start.dateTime);
    const now = new Date();
    const hoursUntil = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
    const refundPct = hoursUntil > 24 ? 100 : 50;
    const refundAmount = (booking.totalPrice * refundPct) / 100;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bookings_cancel_confirm_${idx}`)
        .setLabel(`Cancel & Refund ${refundAmount.toFixed(2)} ${booking.tokenSymbol}`)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("bookings_back_list")
        .setLabel("← Back")
        .setStyle(ButtonStyle.Secondary),
    );

    let content = `⚠️ **Confirm Cancellation**\n\n`;
    content += `**Event:** ${booking.event.summary || "Booking"}\n`;
    content += `**Room:** ${booking.product.name}\n`;
    content += `**Date:** ${formatDiscordDate(start)}\n`;
    content += `**Price paid:** ${booking.totalPrice.toFixed(2)} ${booking.tokenSymbol}\n`;
    content += `**Refund:** ${refundAmount.toFixed(2)} ${booking.tokenSymbol} (${refundPct}%)\n`;
    if (refundPct === 50) {
      content += `\n⚠️ Less than 24h notice — 50% refund only.`;
    }

    await interaction.update({ content, components: [row] });
    return;
  }

  // Confirm cancel
  if (customId.startsWith("bookings_cancel_confirm_")) {
    const idx = parseInt(customId.replace("bookings_cancel_confirm_", ""));
    const booking = state.bookings[idx];
    if (!booking?.event.id) {
      await interaction.update({ content: "⚠️ Invalid booking.", components: [] });
      return;
    }

    await interaction.update({ content: "⏳ Processing cancellation and refund...", components: [] });

    try {
      await processCancellation(interaction, userId, guildId, booking);
      state.bookings.splice(idx, 1);
      bookingsStates.set(userId, state);
    } catch (error) {
      console.error("Error cancelling booking:", error);
      await interaction.editReply({ content: "❌ Failed to cancel booking." });
    }
    return;
  }

  // ── Edit booking ────────────────────────────────────────────────────────

  if (customId.startsWith("bookings_edit_") && !customId.includes("confirm") && !customId.includes("room") && !customId.includes("date") && !customId.includes("time") && !customId.includes("duration") && !customId.includes("url") && !customId.includes("back")) {
    const idx = parseInt(customId.replace("bookings_edit_", ""));
    const booking = state.bookings[idx];
    if (!booking) {
      await interaction.update({ content: "⚠️ Invalid booking.", components: [] });
      return;
    }

    state.selectedIndex = idx;
    state.editStep = "menu";
    // Reset edit fields
    state.newProductSlug = undefined;
    state.newDate = undefined;
    state.newHour = undefined;
    state.newMinute = undefined;
    state.newDuration = undefined;
    state.newUrl = undefined;
    bookingsStates.set(userId, state);

    await showEditMenu(interaction, booking, idx);
    return;
  }

  // Edit menu choices
  if (customId.startsWith("bookings_edit_room_")) {
    const idx = parseInt(customId.replace("bookings_edit_room_", ""));
    state.selectedIndex = idx;
    state.editStep = "room";
    bookingsStates.set(userId, state);

    await showEditRoomPicker(interaction, guildId);
    return;
  }

  if (customId.startsWith("bookings_edit_date_")) {
    const idx = parseInt(customId.replace("bookings_edit_date_", ""));
    state.selectedIndex = idx;
    state.editStep = "date";
    bookingsStates.set(userId, state);

    await showEditDatePicker(interaction);
    return;
  }

  if (customId.startsWith("bookings_edit_time_")) {
    const idx = parseInt(customId.replace("bookings_edit_time_", ""));
    state.selectedIndex = idx;
    state.editStep = "time";
    bookingsStates.set(userId, state);

    await showEditTimePicker(interaction, state, guildId);
    return;
  }

  if (customId.startsWith("bookings_edit_duration_btn_")) {
    // Duration button: bookings_edit_duration_btn_{idx}
    const idx = parseInt(customId.replace("bookings_edit_duration_btn_", ""));
    state.selectedIndex = idx;
    state.editStep = "duration";
    bookingsStates.set(userId, state);

    await showEditDurationPicker(interaction);
    return;
  }

  if (customId.startsWith("bookings_edit_dur_")) {
    // Duration value: bookings_edit_dur_{minutes}
    const minutes = parseInt(customId.replace("bookings_edit_dur_", ""));
    state.newDuration = minutes;
    state.editStep = "confirm";
    bookingsStates.set(userId, state);

    await showEditConfirmation(interaction, userId, guildId);
    return;
  }

  if (customId.startsWith("bookings_edit_url_")) {
    // Show modal for URL
    const modal = new ModalBuilder()
      .setCustomId("bookings_url_modal")
      .setTitle("Event URL")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("event_url")
            .setLabel("Event URL (Luma, Eventbrite, etc.)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("https://lu.ma/your-event")
            .setRequired(false)
            .setMaxLength(500),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  // Confirm edit
  if (customId === "bookings_edit_confirm") {
    await interaction.update({ content: "⏳ Processing changes...", components: [] });

    try {
      await processEdit(interaction, userId, guildId, state);
    } catch (error) {
      console.error("Error editing booking:", error);
      await interaction.editReply({ content: `❌ Failed to edit booking: ${error instanceof Error ? error.message : String(error)}` });
    }
    return;
  }

  // Back to edit menu from sub-picker
  if (customId === "bookings_edit_back_menu") {
    const booking = state.bookings[state.selectedIndex!];
    if (booking) {
      await showEditMenu(interaction, booking, state.selectedIndex!);
    }
    return;
  }
}

// ── Edit Menu ───────────────────────────────────────────────────────────────

async function showEditMenu(interaction: Interaction, booking: BookingInfo, idx: number) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  const start = new Date(booking.event.start.dateTime);
  const end = new Date(booking.event.end.dateTime);

  let content = `✏️ **Edit Booking**\n\n`;
  content += `**Event:** ${booking.event.summary || "Booking"}\n`;
  content += `**Room:** ${booking.product.name}\n`;
  content += `**Date:** ${formatDiscordDate(start)}\n`;
  content += `**Time:** ${formatDiscordTime(start)} - ${formatDiscordTime(end)} (${formatDuration(booking.durationMinutes)})\n`;
  content += `**Price:** ${booking.totalPrice.toFixed(2)} ${booking.tokenSymbol}\n`;
  if (booking.eventUrl) content += `**URL:** ${booking.eventUrl}\n`;
  content += `\nWhat would you like to change?`;

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`bookings_edit_room_${idx}`)
      .setLabel("📍 Room")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bookings_edit_date_${idx}`)
      .setLabel("📅 Date")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bookings_edit_time_${idx}`)
      .setLabel("⏰ Time")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bookings_edit_duration_btn_${idx}`)
      .setLabel("⏱️ Duration")
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`bookings_edit_url_${idx}`)
      .setLabel("🔗 Event URL")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bookings_back_list")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ content, components: [row1, row2] });
}

// ── Edit Sub-pickers ────────────────────────────────────────────────────────

async function showEditRoomPicker(interaction: Interaction, guildId: string) {
  if (!interaction.isButton()) return;

  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const bookableRooms = products?.filter((p) =>
    p.type === "room" && p.calendarId && !disabledCalendars.has(p.calendarId)
  ) || [];

  if (bookableRooms.length === 0) {
    await interaction.update({ content: "⚠️ No available rooms.", components: [] });
    return;
  }

  const options = bookableRooms.map((r) => ({
    label: r.name,
    description: r.capacity ? `👥 ${r.capacity}` : undefined,
    value: r.slug,
  }));

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("bookings_edit_room_select")
      .setPlaceholder("Select new room...")
      .addOptions(options),
  );

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("bookings_edit_back_menu")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ content: "📍 **Select a new room:**", components: [selectRow, navRow] });
}

async function showEditDatePicker(interaction: Interaction) {
  if (!interaction.isButton()) return;

  const today = getLocalToday();
  const dates: { label: string; value: string }[] = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : formatShortDate(d);
    dates.push({ label, value });
  }

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("bookings_edit_date_select")
      .setPlaceholder("Select new date...")
      .addOptions(dates.slice(0, 25)),
  );

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("bookings_edit_back_menu")
      .setLabel("← Back")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ content: "📅 **Select a new date:**", components: [selectRow, navRow] });
}

async function showEditTimePicker(interaction: Interaction, state: BookingsState, guildId: string) {
  if (!interaction.isButton()) return;

  const booking = state.bookings[state.selectedIndex!];
  // Use the new date if set, otherwise the existing date
  const date = state.newDate || new Date(booking.event.start.dateTime);
  const today = getLocalToday();
  const isToday = date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  // Determine the target calendar
  const targetProduct = state.newProductSlug
    ? ((await loadGuildFile(guildId, "products.json")) as unknown as Product[])?.find((p) => p.slug === state.newProductSlug)
    : booking.product;

  // Fetch booked events
  let bookedEvents: CalendarEvent[] = [];
  if (targetProduct?.calendarId) {
    try {
      const calendar = new GoogleCalendarClient();
      const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
      const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);
      const events = await calendar.listEvents(targetProduct.calendarId, startOfDay, endOfDay);
      // Exclude current booking from "booked" display
      bookedEvents = events.filter((e) => e.id !== booking.event.id);
    } catch { /* ignore */ }
  }

  const now = new Date();
  let startHour = 8, startMinute = 0;
  if (isToday) {
    startHour = now.getHours();
    startMinute = now.getMinutes() < 30 ? 30 : 0;
    if (now.getMinutes() >= 30) startHour++;
    if (startHour >= 22) {
      await interaction.update({
        content: "⚠️ No time slots left for today.",
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("bookings_edit_back_menu").setLabel("← Back").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }
    if (startHour < 8) { startHour = 8; startMinute = 0; }
  }

  const slots: { label: string; value: string }[] = [];
  for (let h = startHour; h <= 22; h++) {
    for (const m of [0, 30]) {
      if (h === startHour && m < startMinute) continue;
      if (h === 22 && m === 30) continue;
      const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
      const ampm = h >= 12 ? "pm" : "am";
      const mStr = m === 0 ? "00" : "30";

      const slotStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
      const booked = bookedEvents.some((e) => {
        const es = new Date(e.start.dateTime);
        const ee = new Date(e.end.dateTime);
        return slotStart >= es && slotStart < ee;
      });

      slots.push({
        label: `${booked ? "🔴" : "🟢"} ${h12}:${mStr}${ampm}`,
        value: `${h}:${m}`,
      });
    }
  }

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("bookings_edit_time_select")
      .setPlaceholder("Select new time...")
      .addOptions(slots.slice(0, 25)),
  );

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bookings_edit_back_menu").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ content: "⏰ **Select a new start time:**", components: [selectRow, navRow] });
}

async function showEditDurationPicker(interaction: Interaction) {
  if (!interaction.isButton()) return;

  const durations = [
    { label: "30 min", value: "30" },
    { label: "1 hour", value: "60" },
    { label: "1h 30min", value: "90" },
    { label: "2 hours", value: "120" },
    { label: "3 hours", value: "180" },
    { label: "4 hours", value: "240" },
    { label: "5 hours", value: "300" },
  ];

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...durations.slice(0, 4).map((d) =>
      new ButtonBuilder()
        .setCustomId(`bookings_edit_dur_${d.value}`)
        .setLabel(d.label)
        .setStyle(ButtonStyle.Secondary)
    ),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...durations.slice(4).map((d) =>
      new ButtonBuilder()
        .setCustomId(`bookings_edit_dur_${d.value}`)
        .setLabel(d.label)
        .setStyle(ButtonStyle.Secondary)
    ),
  );
  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bookings_edit_back_menu").setLabel("← Back").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ content: "⏱️ **Select new duration:**", components: [row1, row2, navRow] });
}

// ── Edit Confirmation with Price Diff ───────────────────────────────────────

async function showEditConfirmation(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  const state = bookingsStates.get(userId);
  if (!state || state.selectedIndex === undefined) return;

  const booking = state.bookings[state.selectedIndex];
  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) return;

  // Determine new values (fallback to original)
  const newProduct = state.newProductSlug
    ? products?.find((p) => p.slug === state.newProductSlug) || booking.product
    : booking.product;

  const origStart = new Date(booking.event.start.dateTime);
  const newDate = state.newDate || origStart;
  const newHour = state.newHour ?? origStart.getHours();
  const newMinute = state.newMinute ?? origStart.getMinutes();
  const newDuration = state.newDuration || booking.durationMinutes;

  const newStartTime = new Date(newDate.getFullYear(), newDate.getMonth(), newDate.getDate(), newHour, newMinute);
  const newEndTime = new Date(newStartTime.getTime() + newDuration * 60000);

  // Calculate new price
  const newPricePerHour = newProduct.price.find(
    (p) => p.token.toLowerCase() === booking.tokenSymbol.toLowerCase(),
  )?.amount || newProduct.price[0]?.amount || 0;
  const newTotalPrice = newPricePerHour * (newDuration / 60);

  const priceDiff = newTotalPrice - booking.totalPrice;

  // Check 24h policy for refunds
  const now = new Date();
  const hoursUntilOriginal = (origStart.getTime() - now.getTime()) / (1000 * 60 * 60);
  const lateChange = hoursUntilOriginal <= 24;

  let refundAmount = 0;
  let chargeAmount = 0;

  if (priceDiff > 0) {
    // More expensive → charge the difference
    chargeAmount = priceDiff;
  } else if (priceDiff < 0) {
    // Cheaper → refund, halved if < 24h
    refundAmount = Math.abs(priceDiff);
    if (lateChange) refundAmount = refundAmount / 2;
  }

  // Build summary showing changes
  let content = `📋 **Edit Summary**\n\n`;

  const changes: string[] = [];
  if (state.newProductSlug && state.newProductSlug !== booking.product.slug) {
    changes.push(`**Room:** ${booking.product.name} → **${newProduct.name}**`);
  }
  if (state.newDate) {
    changes.push(`**Date:** ${formatDiscordDate(origStart)} → **${formatDiscordDate(newDate)}**`);
  }
  if (state.newHour !== undefined || state.newMinute !== undefined) {
    changes.push(`**Time:** ${formatDiscordTime(origStart)} → **${formatDiscordTime(newStartTime)}**`);
  }
  if (state.newDuration) {
    changes.push(`**Duration:** ${formatDuration(booking.durationMinutes)} → **${formatDuration(newDuration)}**`);
  }
  if (state.newUrl !== undefined) {
    changes.push(`**URL:** ${state.newUrl || "(removed)"}`);
  }

  if (changes.length === 0) {
    content += `No changes detected.\n`;
  } else {
    content += changes.join("\n") + "\n";
  }

  content += `\n**Original price:** ${booking.totalPrice.toFixed(2)} ${booking.tokenSymbol}`;
  content += `\n**New price:** ${newTotalPrice.toFixed(2)} ${booking.tokenSymbol}`;

  if (chargeAmount > 0) {
    content += `\n\n💰 **You'll be charged ${chargeAmount.toFixed(2)} ${booking.tokenSymbol}** for the difference.`;
  } else if (refundAmount > 0) {
    content += `\n\n💰 **You'll be refunded ${refundAmount.toFixed(2)} ${booking.tokenSymbol}**`;
    if (lateChange) content += ` (50% of ${Math.abs(priceDiff).toFixed(2)} — less than 24h notice)`;
    content += `.`;
  }

  const confirmLabel = chargeAmount > 0
    ? `Pay ${chargeAmount.toFixed(2)} ${booking.tokenSymbol} & Confirm`
    : "Confirm Changes";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("bookings_edit_confirm")
      .setLabel(confirmLabel)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("bookings_edit_back_menu")
      .setLabel("← Back to edit")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bookings_back_list")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update({ content, components: [row] });
  } else if (interaction.isModalSubmit()) {
    await interaction.editReply({ content, components: [row] });
  }
}

// ── Process Edit ────────────────────────────────────────────────────────────

async function processEdit(
  interaction: Interaction & { editReply: Function },
  userId: string,
  guildId: string,
  state: BookingsState,
) {
  const booking = state.bookings[state.selectedIndex!];
  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) throw new Error("Guild settings not found");

  const tokenConfig = guildSettings.tokens.find(
    (t) => t.symbol.toLowerCase() === booking.tokenSymbol.toLowerCase(),
  );
  if (!tokenConfig) throw new Error(`Token ${booking.tokenSymbol} not configured`);

  // Compute new values
  const newProduct = state.newProductSlug
    ? products?.find((p) => p.slug === state.newProductSlug) || booking.product
    : booking.product;

  const origStart = new Date(booking.event.start.dateTime);
  const newDate = state.newDate || origStart;
  const newHour = state.newHour ?? origStart.getHours();
  const newMinute = state.newMinute ?? origStart.getMinutes();
  const newDuration = state.newDuration || booking.durationMinutes;

  const newStartTime = new Date(newDate.getFullYear(), newDate.getMonth(), newDate.getDate(), newHour, newMinute);
  const newEndTime = new Date(newStartTime.getTime() + newDuration * 60000);

  const newPricePerHour = newProduct.price.find(
    (p) => p.token.toLowerCase() === booking.tokenSymbol.toLowerCase(),
  )?.amount || newProduct.price[0]?.amount || 0;
  const newTotalPrice = newPricePerHour * (newDuration / 60);
  const priceDiff = newTotalPrice - booking.totalPrice;

  const now = new Date();
  const hoursUntilOriginal = (origStart.getTime() - now.getTime()) / (1000 * 60 * 60);
  const lateChange = hoursUntilOriginal <= 24;

  // Resolve user address
  const userAddress = await getAccountAddressForToken(userId, tokenConfig);
  if (!userAddress) throw new Error("Could not resolve wallet address");

  let txHash: string | null | undefined;
  let txUrl: string | undefined;

  if (priceDiff > 0) {
    // Charge the user (burn tokens)
    const balance = await getBalance(
      tokenConfig.chain as SupportedChain,
      tokenConfig.address,
      userAddress,
    );
    const requiredAmount = parseUnits(priceDiff.toFixed(6), tokenConfig.decimals);
    if (balance < requiredAmount) {
      const balFmt = parseFloat(formatUnits(balance, tokenConfig.decimals)).toFixed(2);
      await interaction.editReply({
        content: `❌ **Insufficient balance**\n\nYou need ${priceDiff.toFixed(2)} ${booking.tokenSymbol} more but only have ${balFmt} ${booking.tokenSymbol}.`,
      });
      return;
    }

    txHash = await burnTokensFrom(
      tokenConfig.chain as SupportedChain,
      tokenConfig.address,
      userAddress,
      priceDiff.toFixed(6),
      tokenConfig.decimals,
    );
  } else if (priceDiff < 0) {
    // Refund the user (mint tokens)
    let refundAmount = Math.abs(priceDiff);
    if (lateChange) refundAmount = refundAmount / 2;

    if (refundAmount > 0) {
      txHash = await mintTokens(
        tokenConfig.chain as SupportedChain,
        tokenConfig.address,
        userAddress,
        refundAmount.toFixed(6),
      );
    }
  }

  if (txHash) {
    txUrl = getExplorerUrl(tokenConfig.chain, txHash);
  }

  // Update or move the calendar event
  const calendarClient = new GoogleCalendarClient();
  const newCalendarId = newProduct.calendarId!;
  const oldCalendarId = booking.calendarId;

  // Build updated description
  let eventDescription = booking.event.description || "";

  // Update/add Event URL
  if (state.newUrl !== undefined) {
    eventDescription = eventDescription.replace(/\nEvent URL: .+/, "");
    if (state.newUrl) {
      // Insert before User ID line
      const userIdIdx = eventDescription.indexOf("\n\nUser ID:");
      if (userIdIdx >= 0) {
        eventDescription = eventDescription.slice(0, userIdIdx) + `\nEvent URL: ${state.newUrl}` + eventDescription.slice(userIdIdx);
      } else {
        eventDescription += `\nEvent URL: ${state.newUrl}`;
      }
    }
  }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (newCalendarId !== oldCalendarId) {
    // Moving to different calendar: delete old, create new
    await calendarClient.deleteEvent(oldCalendarId, booking.event.id!);
    await calendarClient.ensureCalendarInList(newCalendarId);
    await calendarClient.createEvent(newCalendarId, {
      summary: booking.event.summary || "Room Booking",
      description: eventDescription,
      start: { dateTime: newStartTime.toISOString(), timeZone: tz },
      end: { dateTime: newEndTime.toISOString(), timeZone: tz },
    });
  } else {
    // Same calendar: update in place
    await calendarClient.updateEvent(oldCalendarId, booking.event.id!, {
      summary: booking.event.summary,
      description: eventDescription,
      start: { dateTime: newStartTime.toISOString(), timeZone: tz },
      end: { dateTime: newEndTime.toISOString(), timeZone: tz },
    });
  }

  // Post to transactions channel
  const calendarUrl = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(newCalendarId)}&ctz=${encodeURIComponent(guildSettings.guild.timezone || "Europe/Brussels")}`;

  if (guildSettings.channels?.transactions) {
    try {
      const channel = await interaction.client.channels.fetch(guildSettings.channels.transactions) as TextChannel;
      if (channel) {
        let msg = `✏️ <@${userId}> edited booking for ${newProduct.name}: ${formatDiscordDate(newStartTime)} ${formatDiscordTime(newStartTime)}-${formatDiscordTime(newEndTime)}`;
        if (priceDiff > 0) msg += ` (paid ${priceDiff.toFixed(2)} ${booking.tokenSymbol} extra)`;
        else if (priceDiff < 0) {
          const refund = lateChange ? Math.abs(priceDiff) / 2 : Math.abs(priceDiff);
          msg += ` (refunded ${refund.toFixed(2)} ${booking.tokenSymbol})`;
        }
        msg += ` [[calendar](<${calendarUrl}>)]`;
        if (txUrl) msg += ` [[tx](<${txUrl}>)]`;
        await channel.send(msg);
      }
    } catch (e) { console.error("Error posting edit to transactions:", e); }
  }

  // Done
  bookingsStates.delete(userId);

  let content = `✅ **Booking Updated!**\n\n`;
  content += `**Event:** ${booking.event.summary || "Booking"}\n`;
  content += `**Room:** ${newProduct.name}\n`;
  content += `**When:** ${formatDiscordDate(newStartTime)} at ${formatDiscordTime(newStartTime)}\n`;
  content += `**Until:** ${formatDiscordTime(newEndTime)} (${formatDuration(newDuration)})\n`;
  content += `**New price:** ${newTotalPrice.toFixed(2)} ${booking.tokenSymbol}\n`;
  if (state.newUrl) content += `**URL:** ${state.newUrl}\n`;
  if (txUrl) content += `\n[View transaction](<${txUrl}>)`;

  await interaction.editReply({ content });
}

// ── Process Cancellation ────────────────────────────────────────────────────

async function processCancellation(
  interaction: Interaction & { editReply: Function; client: any },
  userId: string,
  guildId: string,
  booking: BookingInfo,
) {
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) throw new Error("Guild settings not found");

  const tokenConfig = guildSettings.tokens.find(
    (t) => t.symbol.toLowerCase() === booking.tokenSymbol.toLowerCase(),
  ) || guildSettings.tokens[0];

  const start = new Date(booking.event.start.dateTime);
  const end = new Date(booking.event.end.dateTime);
  const now = new Date();
  const hoursUntil = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
  const refundPct = hoursUntil > 24 ? 100 : 50;
  const refundAmount = (booking.totalPrice * refundPct) / 100;

  // Resolve user address
  const userAddress = await getAccountAddressForToken(userId, tokenConfig);
  if (!userAddress) throw new Error("Could not resolve wallet address");

  // Mint refund
  const txHash = await mintTokens(
    tokenConfig.chain as SupportedChain,
    tokenConfig.address,
    userAddress,
    refundAmount.toFixed(6),
  );

  if (!txHash) throw new Error("Refund transaction failed");

  // Delete calendar event
  const calendarClient = new GoogleCalendarClient();
  await calendarClient.deleteEvent(booking.calendarId, booking.event.id!);

  const txUrl = getExplorerUrl(tokenConfig.chain, txHash);
  const calendarUrl = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(booking.calendarId)}&ctz=${encodeURIComponent(guildSettings.guild.timezone || "Europe/Brussels")}`;

  // Post to transactions channel
  if (guildSettings.channels?.transactions) {
    try {
      const channel = await interaction.client.channels.fetch(guildSettings.channels.transactions) as TextChannel;
      if (channel) {
        await channel.send(
          `❌ <@${userId}> cancelled booking for ${booking.product.name} on ${formatDiscordDate(start)} from ${formatDiscordTime(start)} till ${formatDiscordTime(end)} (${refundPct}% refund: ${refundAmount.toFixed(2)} ${booking.tokenSymbol}) [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`,
        );
      }
    } catch (e) { console.error("Error posting cancellation:", e); }
  }

  // Nostr annotation
  try {
    const nostr = Nostr.getInstance();
    const chainId = tokenConfig.chain === "celo" ? 42220 : tokenConfig.chain === "gnosis" ? 100 : 84532;
    const txUri = `ethereum:${chainId}:tx:${txHash}` as URI;
    await nostr.publishMetadata(txUri, {
      content: `Cancelled booking for ${booking.product.name} (${refundPct}% refund)`,
      tags: [["t", "booking"], ["t", "cancellation"], ["t", booking.product.slug]],
    });
  } catch { /* ignore */ }

  await interaction.editReply({
    content: `✅ **Booking Cancelled!**\n\nYour booking for "${booking.event.summary || "Room Booking"}" in ${booking.product.name} has been cancelled.\n\n**Refund:** ${refundAmount.toFixed(2)} ${booking.tokenSymbol} (${refundPct}%)\n\n[View refund transaction](<${txUrl}>)`,
  });
}

// ── Modal Handler ───────────────────────────────────────────────────────────

export async function handleBookingsModal(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isModalSubmit()) return;

  if (interaction.customId === "bookings_url_modal") {
    const state = bookingsStates.get(userId);
    if (!state) {
      await interaction.reply({ content: "⚠️ Session expired.", flags: MessageFlags.Ephemeral });
      return;
    }

    const url = interaction.fields.getTextInputValue("event_url").trim();
    state.newUrl = url || "";
    state.editStep = "confirm";
    bookingsStates.set(userId, state);

    await interaction.deferUpdate();
    await showEditConfirmation(interaction, userId, guildId);
  }
}
