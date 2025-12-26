import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  MessageFlags,
  TextChannel,
} from "discord.js";
import * as chrono from "chrono-node";
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
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${hours} ${hours === 1 ? "hour" : "hours"} and ${remainingMinutes} minutes`;
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

export async function handleBookCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  const productSlug = interaction.options.getString("room");
  const whenInput = interaction.options.getString("when");
  const durationInput = interaction.options.getString("duration") || "1h";
  const eventName = interaction.options.getString("name") ||
    `Booked by ${interaction.user.displayName}`;

  if (!productSlug || !whenInput) {
    await interaction.reply({
      content: "⚠️ Please provide both room and when parameters.",
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

  // Parse time using chrono
  const parsedDates = chrono.parse(whenInput);
  if (parsedDates.length === 0) {
    await interaction.reply({
      content:
        `⚠️ Could not parse time: "${whenInput}"\n\nTry formats like:\n- "tomorrow 2pm"\n- "next Monday at 10am"\n- "14:00"\n- "in 2 hours"`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const startTime = parsedDates[0].start.date();

  // Parse duration
  const durationMatch = durationInput.match(/^(\d+(?:\.\d+)?)\s*(h|hours?|m|minutes?)?$/i);
  if (!durationMatch) {
    await interaction.reply({
      content:
        `⚠️ Invalid duration format: "${durationInput}"\n\nTry formats like: "1h", "30m", "2h", "90m"`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const durationValue = parseFloat(durationMatch[1]);
  const durationUnit = durationMatch[2]?.toLowerCase() || "h";
  const durationMinutes = durationUnit.startsWith("h") ? durationValue * 60 : durationValue;

  if (durationMinutes <= 0) {
    await interaction.reply({
      content: "⚠️ Duration must be greater than 0.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

  // Check if start time is in the past
  if (startTime < new Date()) {
    await interaction.reply({
      content:
        `⚠️ Start time is in the past.\n\nParsed time: ${startTime.toLocaleString()}\nCurrent time: ${
          new Date().toLocaleString()
        }`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Store state
  bookStates.set(userId, {
    productSlug,
    startTime,
    endTime,
    duration: durationMinutes,
    name: eventName,
  });

  // Load guild settings for token symbol
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.reply({
      content: "⚠️ Guild settings not found. Please contact an administrator.",
      flags: MessageFlags.Ephemeral,
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
      .setCustomId("book_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  // Format start date/time nicely
  const startDateStr = formatDiscordDate(startTime);
  const startTimeStr = formatDiscordTime(startTime);
  const endTimeStr = formatDiscordTime(endTime);

  let content = `${"=".repeat(60)}
**Booking Summary**
${"=".repeat(60)}
**Event:**    ${eventName}
**Room:**     ${product.name}
**When:**     ${startDateStr} at ${startTimeStr}
**Until:**    ${endTimeStr}
**Duration:** ${durationMinutes} minutes (${hours.toFixed(1)}h)
**Price:**    ${priceInfo}
${"=".repeat(60)}

**Your current balance:** ${balanceFormatted} ${tokenSymbol}`;

  if (!hasEnoughBalance) {
    const mintInstructions = guildSettings.contributionToken.mintInstructions || "";
    content += `\n\n⚠️ **Insufficient balance**\nYou need ${
      priceAmount.toFixed(2)
    } ${tokenSymbol} but only have ${balanceFormatted} ${tokenSymbol}.\n\n${mintInstructions}`;
  }

  await interaction.reply({
    content,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleBookButton(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton()) return;

  if (interaction.customId === "book_cancel") {
    bookStates.delete(userId);
    await interaction.update({
      content: "❌ Booking cancelled.",
      components: [],
    });
    return;
  }

  if (interaction.customId === "book_confirm") {
    const state = bookStates.get(userId);
    if (!state || !state.productSlug || !state.startTime || !state.endTime) {
      await interaction.update({
        content: "⚠️ Session expired. Please try again.",
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

async function processPayment() {
  // Empty function as requested
}
