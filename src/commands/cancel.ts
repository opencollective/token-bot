import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  MessageFlags,
  StringSelectMenuBuilder,
  TextChannel,
} from "discord.js";
import { CalendarEvent, GoogleCalendarClient } from "../lib/googlecalendar.ts";
import { loadGuildFile, loadGuildSettings } from "../lib/utils.ts";
import { Product } from "../types.ts";
import { mintTokens, SupportedChain } from "../lib/blockchain.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import { Nostr, URI } from "../lib/nostr.ts";

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

// Helper function to format date for Discord messages
function formatDiscordDate(date: Date): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}`;
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

export const cancelStates = new Map<string, {
  userEvents: Array<{
    event: CalendarEvent;
    calendarId: string;
    productName: string;
    productSlug: string;
    priceAmount: number;
  }>;
}>();

export async function handleCancelCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    // Load products to get calendar IDs
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const productsWithCalendar = products?.filter((p) => p.calendarId) || [];

    if (productsWithCalendar.length === 0) {
      await interaction.editReply({
        content: "⚠️ No rooms with calendar integration found.",
      });
      return;
    }

    const calendarClient = new GoogleCalendarClient();

    // Get current date and a date far in the future
    const now = new Date();
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1); // Search up to 1 year ahead

    // Find all events booked by this user across all calendars
    const userEvents: Array<{
      event: CalendarEvent;
      calendarId: string;
      productName: string;
      productSlug: string;
      priceAmount: number;
    }> = [];

    for (const product of productsWithCalendar) {
      try {
        await calendarClient.ensureCalendarInList(product.calendarId!);
        const events = await calendarClient.listEvents(
          product.calendarId!,
          now,
          futureDate,
        );

        // Filter events booked by this user
        for (const event of events) {
          if (event.description?.includes(`User ID: ${userId}`)) {
            // Calculate price based on duration
            const startDate = new Date(event.start.dateTime);
            const endDate = new Date(event.end.dateTime);
            const durationMinutes = Math.round(
              (endDate.getTime() - startDate.getTime()) / 60000,
            );
            const hours = durationMinutes / 60;
            const priceAmount = product.price[0].amount * hours;

            userEvents.push({
              event,
              calendarId: product.calendarId!,
              productName: product.name,
              productSlug: product.slug,
              priceAmount,
            });
          }
        }
      } catch (error) {
        console.error(`Error fetching events for ${product.name}:`, error);
      }
    }

    if (userEvents.length === 0) {
      await interaction.editReply({
        content: "📅 You don't have any upcoming bookings.",
      });
      return;
    }

    // Store state for deletion
    cancelStates.set(userId, { userEvents });

    // Create select menu with events
    const options = userEvents.map((item, index) => {
      const startDate = new Date(item.event.start.dateTime);
      const endDate = new Date(item.event.end.dateTime);
      const duration = Math.round((endDate.getTime() - startDate.getTime()) / 60000);

      return {
        label: `${item.event.summary || "Booking"} - ${item.productName}`,
        description: `${startDate.toLocaleString()} (${duration}min)`,
        value: index.toString(),
      };
    }).slice(0, 25); // Discord limit is 25 options

    const selectMenu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("cancel_select_event")
        .setPlaceholder("Select a booking to cancel")
        .addOptions(options),
    );

    await interaction.editReply({
      content:
        `📅 **Your Upcoming Bookings**\n\nYou have ${userEvents.length} upcoming booking(s). Select one to cancel:`,
      components: [selectMenu],
    });
  } catch (error) {
    console.error("Error in cancel command:", error);
    await interaction.editReply({
      content: "❌ An error occurred while fetching your bookings.",
    });
  }
}

export async function handleCancelSelect(
  interaction: Interaction,
  userId: string,
) {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== "cancel_select_event") return;

  const state = cancelStates.get(userId);
  if (!state) {
    await interaction.update({
      content: "⚠️ Session expired. Please try again.",
      components: [],
    });
    return;
  }

  const selectedIndex = parseInt(interaction.values[0]);
  const selectedItem = state.userEvents[selectedIndex];

  if (!selectedItem) {
    await interaction.update({
      content: "⚠️ Invalid selection.",
      components: [],
    });
    return;
  }

  const startDate = new Date(selectedItem.event.start.dateTime);
  const endDate = new Date(selectedItem.event.end.dateTime);
  const duration = Math.round((endDate.getTime() - startDate.getTime()) / 60000);

  // Calculate refund percentage (100% if more than 24h in advance, 50% otherwise)
  const now = new Date();
  const hoursUntilBooking = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60);
  const refundPercentage = hoursUntilBooking > 24 ? 100 : 50;
  const refundAmount = (selectedItem.priceAmount * refundPercentage) / 100;

  // Load guild settings for token symbol
  const guildId = interaction.guildId!;
  const guildSettings = await loadGuildSettings(guildId);
  const tokenSymbol = guildSettings?.contributionToken.symbol || "tokens";

  // Create confirmation buttons
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cancel_confirm_${selectedIndex}`)
      .setLabel("Yes, Cancel Booking")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("cancel_abort")
      .setLabel("No, Keep It")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    content: `**Confirm Cancellation**

**Event:** ${selectedItem.event.summary || "Booking"}
**Room:** ${selectedItem.productName}
**Date:** ${startDate.toLocaleString()}
**Duration:** ${duration} minutes

**Original Price:** ${selectedItem.priceAmount.toFixed(2)} ${tokenSymbol}
**Refund:** ${refundAmount.toFixed(2)} ${tokenSymbol} (${refundPercentage}%)

${
      refundPercentage === 50
        ? "⚠️ Less than 24 hours notice - 50% refund only."
        : "✅ More than 24 hours notice - full refund."
    }

Are you sure you want to cancel this booking?`,
    components: [row],
  });
}

export async function handleCancelButton(
  interaction: Interaction,
  userId: string,
) {
  if (!interaction.isButton()) return;

  if (interaction.customId === "cancel_abort") {
    cancelStates.delete(userId);
    await interaction.update({
      content: "✅ Booking kept. No changes made.",
      components: [],
    });
    return;
  }

  if (interaction.customId.startsWith("cancel_confirm_")) {
    const selectedIndex = parseInt(interaction.customId.replace("cancel_confirm_", ""));
    const state = cancelStates.get(userId);

    if (!state) {
      await interaction.update({
        content: "⚠️ Session expired. Please try again.",
        components: [],
      });
      return;
    }

    const selectedItem = state.userEvents[selectedIndex];

    if (!selectedItem || !selectedItem.event.id) {
      await interaction.update({
        content: "⚠️ Invalid event.",
        components: [],
      });
      return;
    }

    await interaction.update({
      content: "⏳ Processing cancellation and refund...",
      components: [],
    });

    try {
      const guildId = interaction.guildId!;
      const guildSettings = await loadGuildSettings(guildId);

      if (!guildSettings) {
        await interaction.editReply({
          content: "⚠️ Guild settings not found. Please contact an administrator.",
        });
        return;
      }

      const tokenSymbol = guildSettings.contributionToken.symbol;

      // Calculate refund
      const startDate = new Date(selectedItem.event.start.dateTime);
      const endDate = new Date(selectedItem.event.end.dateTime);
      const now = new Date();
      const hoursUntilBooking = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60);
      const refundPercentage = hoursUntilBooking > 24 ? 100 : 50;
      const refundAmount = (selectedItem.priceAmount * refundPercentage) / 100;
      const duration = Math.round((endDate.getTime() - startDate.getTime()) / 60000);

      // Get user's blockchain address
      const userAddress = await getCachedAddress(userId);

      // Mint tokens to refund the user
      const txHash = await mintTokens(
        guildSettings.contributionToken.chain as SupportedChain,
        guildSettings.contributionToken.address,
        userAddress,
        refundAmount.toString(),
      );

      if (!txHash) {
        await interaction.editReply({
          content: "❌ Failed to process refund. Please contact an administrator.",
        });
        return;
      }

      // Delete the calendar event
      const calendarClient = new GoogleCalendarClient();

      await calendarClient.deleteEvent(
        selectedItem.calendarId,
        selectedItem.event.id,
      );

      // Get explorer URL based on chain
      const chainId = guildSettings.contributionToken.chain === "celo" ? 42220 : 84532;
      const explorerBaseUrl = guildSettings.contributionToken.chain === "celo"
        ? "https://celoscan.io"
        : "https://sepolia.basescan.org";
      const txUrl = `${explorerBaseUrl}/tx/${txHash}`;

      // Send message to #transactions channel
      if (guildSettings.channels?.transactions && interaction.guild) {
        try {
          const transactionsChannel = await interaction.guild.channels.fetch(
            guildSettings.channels.transactions,
          ) as TextChannel;

          if (transactionsChannel) {
            const calendarUrl = `https://calendar.google.com/calendar/embed?src=${
              encodeURIComponent(selectedItem.calendarId)
            }&ctz=${encodeURIComponent(guildSettings.guild.timezone || "Europe/Brussels")}`;

            const dateStr = formatDiscordDate(startDate);
            const startTimeStr = formatDiscordTime(startDate);
            const endTimeStr = formatDiscordTime(endDate);

            await transactionsChannel.send(
              `❌ <@${userId}> cancelled booking for ${selectedItem.productName} on ${dateStr} from ${startTimeStr} till ${endTimeStr} (${refundPercentage}% refund: ${
                refundAmount.toFixed(2)
              } ${tokenSymbol}) [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`,
            );
          }
        } catch (error) {
          console.error("Error sending message to transactions channel:", error);
        }
      }

      // Send Nostr annotation
      try {
        const nostr = Nostr.getInstance();
        const txUri = `ethereum:${chainId}:tx:${txHash}` as URI;

        await nostr.publishMetadata(txUri, {
          content:
            `Cancelled booking for ${selectedItem.productName} room (${refundPercentage}% refund)`,
          tags: [
            ["t", "booking"],
            ["t", "cancellation"],
            ["t", selectedItem.productSlug],
          ],
        });
      } catch (error) {
        console.error("Error sending Nostr annotation:", error);
      }

      // Send message to room-specific channel if configured
      try {
        const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
        const product = products?.find((p) => p.slug === selectedItem.productSlug);

        if (product?.channelId && interaction.guild) {
          const roomChannel = await interaction.guild.channels.fetch(
            product.channelId,
          ) as TextChannel;

          if (roomChannel) {
            const calendarUrl = `https://calendar.google.com/calendar/embed?src=${
              encodeURIComponent(selectedItem.calendarId)
            }&ctz=${encodeURIComponent(guildSettings.guild.timezone || "Europe/Brussels")}`;

            const dateStr = formatDiscordDate(startDate);
            const startTimeStr = formatDiscordTime(startDate);
            const endTimeStr = formatDiscordTime(endDate);

            await roomChannel.send(
              `❌ <@${userId}> cancelled booking for ${selectedItem.productName} on ${dateStr} from ${startTimeStr} till ${endTimeStr} (${refundPercentage}% refund: ${
                refundAmount.toFixed(2)
              } ${tokenSymbol}) [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`,
            );
          }
        }
      } catch (error) {
        console.error("Error sending message to room channel:", error);
      }

      cancelStates.delete(userId);

      await interaction.editReply({
        content: `✅ **Booking Cancelled!**

Your booking for "${
          selectedItem.event.summary || "Room Booking"
        }" in ${selectedItem.productName} has been cancelled.

**Refund:** ${refundAmount.toFixed(2)} ${tokenSymbol} (${refundPercentage}%)

[View refund transaction](<${txUrl}>)`,
      });
    } catch (error) {
      console.error("Error cancelling booking:", error);
      await interaction.editReply({
        content: "❌ Failed to cancel booking. Please try again or contact an administrator.",
      });
    }
  }
}
