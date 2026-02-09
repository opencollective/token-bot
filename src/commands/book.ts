import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  MessageFlags,
  StringSelectMenuBuilder,
  TextChannel,
} from "discord.js";
import { BookState, Product } from "../types.ts";
import { loadGuildFile, loadGuildSettings } from "../lib/utils.ts";
import { GoogleCalendarClient } from "../lib/googlecalendar.ts";
import { burnTokensFrom, getBalance, SupportedChain } from "../lib/blockchain.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { formatUnits, parseUnits } from "@wevm/viem";

// Cache for Discord ID to blockchain address mapping
const addressCache = new Map<string, string>();

// Helper function to get blockchain address with caching
async function getCachedAddress(discordUserId: string): Promise<string> {
  if (addressCache.has(discordUserId)) {
    return addressCache.get(discordUserId)!;
  }

  const address = await getAccountAddressFromDiscordUserId(discordUserId);
  addressCache.set(discordUserId, address);
  return address;
}

export const bookStates = new Map<string, BookState>();

// Helper function to format duration for display
function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minutes`;
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

// Get short day name
function getShortDayName(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[date.getDay()];
}

// Get upcoming dates for selection (today + next 6 days)
function getDateOptions(): { label: string; value: string; date: Date }[] {
  const options: { label: string; value: string; date: Date }[] = [];
  const now = new Date();
  
  for (let i = 0; i < 7; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() + i);
    date.setHours(0, 0, 0, 0);
    
    let label: string;
    if (i === 0) {
      label = "Today";
    } else if (i === 1) {
      label = "Tomorrow";
    } else {
      const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
      label = `${dayName} (${date.getDate()}/${date.getMonth() + 1})`;
    }
    
    options.push({
      label,
      value: date.toISOString().split("T")[0],
      date,
    });
  }
  
  return options;
}

// Get available hours for a date
function getHourOptions(selectedDate: Date, isToday: boolean): { label: string; value: string }[] {
  const options: { label: string; value: string }[] = [];
  const startHour = isToday ? Math.max(8, new Date().getHours() + 1) : 8;
  const endHour = 22; // 10pm
  
  for (let hour = startHour; hour <= endHour; hour++) {
    const hour12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    const ampm = hour >= 12 ? "pm" : "am";
    options.push({
      label: `${hour12}${ampm}`,
      value: hour.toString(),
    });
  }
  
  return options;
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
  roomName: string,
): Promise<string> {
  try {
    const calendar = new GoogleCalendarClient();
    
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    const events = await calendar.listEvents(calendarId, startOfDay, endOfDay);
    
    if (events.length === 0) {
      return `📅 **${roomName}** on **${formatDiscordDate(date)}**\n✅ Available all day (8am - 10pm)`;
    }
    
    let availability = `📅 **${roomName}** on **${formatDiscordDate(date)}**\n\n**Booked slots:**\n`;
    
    for (const event of events) {
      const start = new Date(event.start.dateTime);
      const end = new Date(event.end.dateTime);
      availability += `🔴 ${formatDiscordTime(start)} - ${formatDiscordTime(end)}: ${event.summary || "Booked"}\n`;
    }
    
    return availability;
  } catch (error) {
    console.error("Error fetching availability:", error);
    return `📅 **${roomName}** on **${formatDiscordDate(date)}**\n⚠️ Could not fetch availability`;
  }
}

export async function handleBookCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  const productSlug = interaction.options.getString("room");
  const eventName = interaction.options.getString("name") ||
    `Booked by ${interaction.user.displayName}`;

  if (!productSlug) {
    await interaction.reply({
      content: "⚠️ Please select a room.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Load products to verify slug
  const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
  const product = products?.find((p) => p.slug === productSlug);

  if (!product) {
    await interaction.reply({
      content: `⚠️ Meeting room "${productSlug}" not found.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!product.calendarId) {
    await interaction.reply({
      content: "⚠️ This room doesn't have a calendar configured.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Initialize booking state
  bookStates.set(userId, {
    step: "date",
    productSlug,
    name: eventName,
    guildId,
  });

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
  
  // Third row: Last day + Other
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
      .setLabel("Other date...")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("book_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );
  rows.push(row3);

  await interaction.reply({
    content: `🗓️ **Book ${product.name}**\n\n**Event name:** ${eventName}\n\nSelect a date:`,
    components: rows,
    flags: MessageFlags.Ephemeral,
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

  // Cancel button
  if (customId === "book_cancel") {
    bookStates.delete(userId);
    await interaction.update({
      content: "❌ Booking cancelled.",
      components: [],
    });
    return;
  }

  // Date selection
  if (customId.startsWith("book_date_")) {
    if (!state) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    const dateValue = customId.replace("book_date_", "");
    
    if (dateValue === "other") {
      // For "other", we'll ask them to type a date - simplified for now, just extend the range
      const extendedDates: { label: string; value: string }[] = [];
      const now = new Date();
      
      for (let i = 7; i < 21; i++) { // Next 2 weeks beyond the initial 7 days
        const date = new Date(now);
        date.setDate(now.getDate() + i);
        const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
        extendedDates.push({
          label: `${dayName} ${date.getDate()}/${date.getMonth() + 1}`,
          value: date.toISOString().split("T")[0],
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
          .setCustomId("book_cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger),
      );

      await interaction.update({
        content: "📅 Select a date from the next 2 weeks:",
        components: [row, cancelRow],
      });
      return;
    }

    // Parse the selected date
    const selectedDate = new Date(dateValue);
    state.selectedDate = selectedDate;
    state.step = "hour";
    bookStates.set(userId, state);

    // Load product for availability
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === state.productSlug);

    // Get and show availability
    const availability = product?.calendarId 
      ? await formatAvailability(product.calendarId, selectedDate, product.name)
      : "";

    // Build hour selection
    const isToday = selectedDate.toDateString() === new Date().toDateString();
    const hourOptions = getHourOptions(selectedDate, isToday);

    if (hourOptions.length === 0) {
      await interaction.update({
        content: `${availability}\n\n⚠️ No available hours left for today. Please select a different date.`,
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

    // Split hours into rows (max 5 buttons per row)
    const hourRows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < hourOptions.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const chunk = hourOptions.slice(i, i + 5);
      for (const hour of chunk) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`book_hour_${hour.value}`)
            .setLabel(hour.label)
            .setStyle(ButtonStyle.Secondary),
        );
      }
      hourRows.push(row);
    }

    // Add back/cancel row
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

    // Discord allows max 5 rows
    const components = [...hourRows.slice(0, 4), navRow];

    await interaction.update({
      content: `${availability}\n\n⏰ **Select start time:**`,
      components,
    });
    return;
  }

  // Back to date selection
  if (customId === "book_back_date") {
    if (!state) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    state.step = "date";
    state.selectedDate = undefined;
    state.selectedHour = undefined;
    bookStates.set(userId, state);

    // Rebuild date selection (same as initial)
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
        .setLabel("Other date...")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("book_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );
    rows.push(row3);

    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === state.productSlug);

    await interaction.update({
      content: `🗓️ **Book ${product?.name || "Room"}**\n\n**Event name:** ${state.name}\n\nSelect a date:`,
      components: rows,
    });
    return;
  }

  // Hour selection
  if (customId.startsWith("book_hour_")) {
    if (!state || !state.selectedDate) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    const hour = parseInt(customId.replace("book_hour_", ""));
    state.selectedHour = hour;
    state.step = "minute";
    bookStates.set(userId, state);

    // Show minute selection (00 or 30)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("book_minute_0")
        .setLabel(":00")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("book_minute_30")
        .setLabel(":30")
        .setStyle(ButtonStyle.Primary),
    );

    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("book_back_hour")
        .setLabel("← Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("book_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    const hour12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    const ampm = hour >= 12 ? "pm" : "am";

    await interaction.update({
      content: `⏰ **Selected: ${hour12}${ampm}**\n\nSelect minutes:`,
      components: [row, navRow],
    });
    return;
  }

  // Back to hour selection
  if (customId === "book_back_hour") {
    if (!state || !state.selectedDate) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    state.step = "hour";
    state.selectedHour = undefined;
    bookStates.set(userId, state);

    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === state.productSlug);

    const availability = product?.calendarId 
      ? await formatAvailability(product.calendarId, state.selectedDate, product.name)
      : "";

    const isToday = state.selectedDate.toDateString() === new Date().toDateString();
    const hourOptions = getHourOptions(state.selectedDate, isToday);

    const hourRows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < hourOptions.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const chunk = hourOptions.slice(i, i + 5);
      for (const hour of chunk) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`book_hour_${hour.value}`)
            .setLabel(hour.label)
            .setStyle(ButtonStyle.Secondary),
        );
      }
      hourRows.push(row);
    }

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

    const components = [...hourRows.slice(0, 4), navRow];

    await interaction.update({
      content: `${availability}\n\n⏰ **Select start time:**`,
      components,
    });
    return;
  }

  // Minute selection
  if (customId.startsWith("book_minute_")) {
    if (!state || !state.selectedDate || state.selectedHour === undefined) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    const minute = parseInt(customId.replace("book_minute_", ""));
    state.selectedMinute = minute;
    state.step = "duration";
    bookStates.set(userId, state);

    // Build duration selection
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
        .setCustomId("book_back_minute")
        .setLabel("← Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("book_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    const hour12 = state.selectedHour > 12 ? state.selectedHour - 12 : state.selectedHour === 0 ? 12 : state.selectedHour;
    const ampm = state.selectedHour >= 12 ? "pm" : "am";
    const minuteStr = minute < 10 ? `0${minute}` : minute.toString();

    await interaction.update({
      content: `⏰ **Selected: ${hour12}:${minuteStr}${ampm}**\n\n⏱️ Select duration:`,
      components: [row1, row2, navRow],
    });
    return;
  }

  // Back to minute selection
  if (customId === "book_back_minute") {
    if (!state || !state.selectedDate || state.selectedHour === undefined) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    state.step = "minute";
    state.selectedMinute = undefined;
    bookStates.set(userId, state);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("book_minute_0")
        .setLabel(":00")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("book_minute_30")
        .setLabel(":30")
        .setStyle(ButtonStyle.Primary),
    );

    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("book_back_hour")
        .setLabel("← Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("book_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    const hour12 = state.selectedHour > 12 ? state.selectedHour - 12 : state.selectedHour === 0 ? 12 : state.selectedHour;
    const ampm = state.selectedHour >= 12 ? "pm" : "am";

    await interaction.update({
      content: `⏰ **Selected: ${hour12}${ampm}**\n\nSelect minutes:`,
      components: [row, navRow],
    });
    return;
  }

  // Duration selection - show confirmation
  if (customId.startsWith("book_duration_")) {
    if (!state || !state.selectedDate || state.selectedHour === undefined || state.selectedMinute === undefined) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    const durationMinutes = parseInt(customId.replace("book_duration_", ""));
    
    // Build start and end times
    const startTime = new Date(state.selectedDate);
    startTime.setHours(state.selectedHour, state.selectedMinute, 0, 0);
    
    const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

    state.startTime = startTime;
    state.endTime = endTime;
    state.duration = durationMinutes;
    state.step = "confirm";
    bookStates.set(userId, state);

    // Load product and guild settings for pricing
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === state.productSlug);

    if (!product) {
      await interaction.update({
        content: "⚠️ Product not found.",
        components: [],
      });
      return;
    }

    const guildSettings = await loadGuildSettings(guildId);
    if (!guildSettings) {
      await interaction.update({
        content: "⚠️ Guild settings not found.",
        components: [],
      });
      return;
    }

    // Calculate price
    const hours = durationMinutes / 60;
    const priceAmount = product.price[0].amount * hours;
    const tokenSymbol = guildSettings.contributionToken.symbol;
    const priceInfo = product.price
      .map((p) => `${(p.amount * hours).toFixed(2)} ${p.token}`)
      .join(" or ");

    // Get user's balance
    const userAddress = await getCachedAddress(userId);
    const balance = await getBalance(
      guildSettings.contributionToken.chain as SupportedChain,
      guildSettings.contributionToken.address,
      userAddress,
    );
    const balanceFormatted = parseFloat(
      formatUnits(balance, guildSettings.contributionToken.decimals),
    ).toFixed(2);
    const requiredAmount = parseUnits(
      priceAmount.toString(),
      guildSettings.contributionToken.decimals,
    );
    const hasEnoughBalance = balance >= requiredAmount;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("book_confirm")
        .setLabel(`Pay ${priceAmount.toFixed(2)} ${tokenSymbol} to confirm`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(!hasEnoughBalance),
      new ButtonBuilder()
        .setCustomId("book_back_duration")
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

    let content = `${"═".repeat(40)}
**📋 Booking Summary**
${"═".repeat(40)}
**Event:**    ${state.name}
**Room:**     ${product.name}
**When:**     ${startDateStr} at ${startTimeStr}
**Until:**    ${endTimeStr}
**Duration:** ${formatDuration(durationMinutes)}
**Price:**    ${priceInfo}
${"═".repeat(40)}

**Your balance:** ${balanceFormatted} ${tokenSymbol}`;

    if (!hasEnoughBalance) {
      const mintInstructions = guildSettings.contributionToken.mintInstructions || "";
      content += `\n\n⚠️ **Insufficient balance**\nYou need ${priceAmount.toFixed(2)} ${tokenSymbol} but only have ${balanceFormatted} ${tokenSymbol}.\n\n${mintInstructions}`;
    }

    await interaction.update({
      content,
      components: [row],
    });
    return;
  }

  // Back to duration selection
  if (customId === "book_back_duration") {
    if (!state || !state.selectedDate || state.selectedHour === undefined || state.selectedMinute === undefined) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    state.step = "duration";
    state.startTime = undefined;
    state.endTime = undefined;
    state.duration = undefined;
    bookStates.set(userId, state);

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
        .setCustomId("book_back_minute")
        .setLabel("← Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("book_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    const hour12 = state.selectedHour > 12 ? state.selectedHour - 12 : state.selectedHour === 0 ? 12 : state.selectedHour;
    const ampm = state.selectedHour >= 12 ? "pm" : "am";
    const minuteStr = state.selectedMinute < 10 ? `0${state.selectedMinute}` : state.selectedMinute.toString();

    await interaction.update({
      content: `⏰ **Selected: ${hour12}:${minuteStr}${ampm}**\n\n⏱️ Select duration:`,
      components: [row1, row2, navRow],
    });
    return;
  }

  // Final confirmation - process payment and create booking
  if (customId === "book_confirm") {
    if (!state || !state.productSlug || !state.startTime || !state.endTime) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    await interaction.update({
      content: "⏳ Processing payment...",
      components: [],
    });

    // Load products to get calendarId and price
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === state.productSlug);

    if (!product?.calendarId) {
      await interaction.editReply({
        content: "⚠️ This room doesn't have a calendar configured.",
      });
      return;
    }

    // Load guild settings for token info
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

    // Calculate price
    const hours = (state.duration || 60) / 60;
    const priceAmount = product.price[0].amount * hours;
    const tokenSymbol = guildSettings.contributionToken.symbol;

    // Process payment
    try {
      // Get user's blockchain address
      const userAddress = await getCachedAddress(userId);

      // Check balance first
      const balance = await getBalance(
        guildSettings.contributionToken.chain as SupportedChain,
        guildSettings.contributionToken.address,
        userAddress,
      );

      const requiredAmount = parseUnits(
        priceAmount.toString(),
        guildSettings.contributionToken.decimals,
      );

      if (balance < requiredAmount) {
        const balanceFormatted = parseFloat(
          formatUnits(balance, guildSettings.contributionToken.decimals),
        ).toFixed(2);
        const mintInstructions = guildSettings.contributionToken.mintInstructions || "";

        await interaction.editReply({
          content: `❌ **Insufficient balance**

**Balance:** ${balanceFormatted} ${tokenSymbol}
**Required:** ${priceAmount.toFixed(2)} ${tokenSymbol}

${mintInstructions}`,
        });
        return;
      }

      // Burn tokens from user
      const txHash = await burnTokensFrom(
        guildSettings.contributionToken.chain as SupportedChain,
        guildSettings.contributionToken.address,
        userAddress,
        priceAmount.toString(),
        guildSettings.contributionToken.decimals,
      );

      if (!txHash) {
        await interaction.editReply({
          content: "❌ Payment failed. Transaction returned no hash.",
        });
        return;
      }

      // Format booking time
      const bookingTime = new Date();
      const bookingDateStr = formatDiscordDate(bookingTime);
      const bookingTimeStr = formatDiscordTime(bookingTime);

      // Create calendar event
      try {
        const calendarClient = new GoogleCalendarClient();

        await calendarClient.ensureCalendarInList(product.calendarId);

        // Get explorer URL based on chain
        const chainId = guildSettings.contributionToken.chain === "celo" ? 42220 : 84532;
        const explorerBaseUrl = guildSettings.contributionToken.chain === "celo"
          ? "https://celoscan.io"
          : "https://sepolia.basescan.org";
        const txUrl = `${explorerBaseUrl}/tx/${txHash}`;

        // Send message to #transactions channel and get message link
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
                `🗓️ <@${userId}> booked ${product.name} for ${dateStr} from ${startTimeStr} till ${endTimeStr} for ${
                  priceAmount.toFixed(2)
                } ${tokenSymbol} [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`,
              );

              // Create Discord message link
              transactionMessageLink =
                `https://discord.com/channels/${guildId}/${guildSettings.channels.transactions}/${message.id}`;
            }
          } catch (error) {
            console.error("Error sending message to transactions channel:", error);
          }
        }

        // Create detailed calendar event description
        let eventDescription =
          `Booked by ${interaction.user.displayName} (@${interaction.user.username}) on ${bookingDateStr} at ${bookingTimeStr} for ${
            priceAmount.toFixed(2)
          } ${tokenSymbol}`;
        if (transactionMessageLink) {
          eventDescription += `\n${transactionMessageLink}`;
        }
        eventDescription +=
          `\n\nPlease reach out to @${interaction.user.username} on Discord for questions about this booking.
          \n\nTo cancel, ${interaction.user.displayName} needs to run the /cancel command in Discord.`;

        await calendarClient.createEvent(product.calendarId, {
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
        });

        // Send Nostr annotation
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

        // Send message to room-specific channel if configured
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
                `🗓️ <@${userId}> booked ${product.name} for ${dateStr} from ${startTimeStr} till ${endTimeStr} for ${
                  priceAmount.toFixed(2)
                } ${tokenSymbol} [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`,
              );
            }
          } catch (error) {
            console.error("Error sending message to room channel:", error);
          }
        }

        bookStates.delete(userId);

        await interaction.editReply({
          content: `✅ **Booking Confirmed!**

**Event:** ${state.name}
**Room:** ${product.name}
**Start:** ${state.startTime.toLocaleString()}
**End:** ${state.endTime.toLocaleString()}
**Paid:** ${priceAmount.toFixed(2)} ${tokenSymbol}

[View transaction](<${txUrl}>)

You can view the calendar of all bookings for the ${product.name} room on its [public calendar](<${calendarUrl}>).`,
        });
      } catch (error: any) {
        console.error("Error creating calendar event:", error);

        let errorMessage = "❌ Payment successful but booking failed.";
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

      await interaction.editReply({
        content: `❌ **Payment failed**

${error.message}

Please ensure you have enough ${tokenSymbol} tokens in your account.`,
      });
    }
  }
}

// Handle select menu interactions
export async function handleBookSelect(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isStringSelectMenu()) return;

  const customId = interaction.customId;
  const state = bookStates.get(userId);

  if (customId === "book_date_select") {
    if (!state) {
      await interaction.update({
        content: "⚠️ Session expired. Please run /book again.",
        components: [],
      });
      return;
    }

    const dateValue = interaction.values[0];
    const selectedDate = new Date(dateValue);
    state.selectedDate = selectedDate;
    state.step = "hour";
    bookStates.set(userId, state);

    // Load product for availability
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === state.productSlug);

    // Get and show availability
    const availability = product?.calendarId 
      ? await formatAvailability(product.calendarId, selectedDate, product.name)
      : "";

    // Build hour selection
    const isToday = selectedDate.toDateString() === new Date().toDateString();
    const hourOptions = getHourOptions(selectedDate, isToday);

    const hourRows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < hourOptions.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      const chunk = hourOptions.slice(i, i + 5);
      for (const hour of chunk) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`book_hour_${hour.value}`)
            .setLabel(hour.label)
            .setStyle(ButtonStyle.Secondary),
        );
      }
      hourRows.push(row);
    }

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

    const components = [...hourRows.slice(0, 4), navRow];

    await interaction.update({
      content: `${availability}\n\n⏰ **Select start time:**`,
      components,
    });
  }
}
