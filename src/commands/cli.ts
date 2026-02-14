/**
 * Interactive CLI to simulate Discord bot commands locally
 */

import { Select, Input, Confirm } from "@cliffy/prompt";
import * as chrono from "chrono-node";
import { GoogleCalendarClient } from "../lib/googlecalendar.ts";
import { loadGuildFile } from "../lib/utils.ts";
import type { Product } from "../types.ts";

interface GuildSettings {
  guild: {
    id: string;
    name: string;
    icon?: string;
  };
  tokens: Array<{
    name: string;
    symbol: string;
  }>;
}

async function getGuilds(): Promise<Array<{ id: string; name: string }>> {
  const guilds: Array<{ id: string; name: string }> = [];

  try {
    for await (const entry of Deno.readDir("./data")) {
      if (entry.isDirectory && /^\d+$/.test(entry.name)) {
        try {
          const settings = (await loadGuildFile(
            entry.name,
            "settings.json",
          )) as GuildSettings;
          if (settings?.guild) {
            guilds.push({
              id: entry.name,
              name: settings.guild.name || `Guild ${entry.name}`,
            });
          }
        } catch {
          // Skip if no settings.json
        }
      }
    }
  } catch (error) {
    console.error("Error reading guilds:", error);
  }

  return guilds;
}

async function selectGuild(): Promise<{ id: string; name: string } | null> {
  const guilds = await getGuilds();

  if (guilds.length === 0) {
    console.log("❌ No guilds found in ./data directory");
    return null;
  }

  if (guilds.length === 1) {
    console.log(`Using guild: ${guilds[0].name}\n`);
    return guilds[0];
  }

  const guildId = await Select.prompt({
    message: "Select a guild",
    options: guilds.map((g) => ({ name: g.name, value: g.id })),
  });

  return guilds.find((g) => g.id === guildId) || null;
}

async function handleBookCommand(
  guildId: string,
  calendarClient: GoogleCalendarClient,
) {
  console.log("\n📅 Book a Room\n");

  // Load products
  const products = (await loadGuildFile(
    guildId,
    "products.json",
  )) as Product[];

  if (!products || products.length === 0) {
    console.log("❌ No products found for this guild");
    return;
  }

  // Filter rooms with calendarId
  const bookableRooms = products.filter(
    (p) => p.type === "room" && p.calendarId,
  );

  if (bookableRooms.length === 0) {
    console.log("❌ No rooms with calendar integration found");
    console.log("\nAvailable rooms without calendar:");
    products
      .filter((p) => p.type === "room")
      .forEach((p) => {
        console.log(`  - ${p.name} (${p.slug})`);
      });
    return;
  }

  // Select room
  const roomSlug = await Select.prompt({
    message: "Select a room",
    options: bookableRooms.map((r) => ({
      name: `${r.name} - ${r.price.map((p) => `${p.amount} ${p.token}`).join(" or ")}/${r.unit}`,
      value: r.slug,
    })),
  });

  const room = bookableRooms.find((r) => r.slug === roomSlug);
  if (!room) {
    console.log("❌ Room not found");
    return;
  }

  console.log(`\nBooking: ${room.name}`);
  console.log(`Calendar ID: ${room.calendarId}\n`);

  // Get start time
  const startTimeInput = await Input.prompt({
    message:
      'Start time (e.g., "2pm", "14:00", "tomorrow at 3pm", "next Monday at 10am")',
    default: "now",
  });

  // Parse time using chrono
  const parsedDates = chrono.parse(startTimeInput);
  if (parsedDates.length === 0) {
    console.log(`❌ Could not parse time: "${startTimeInput}"`);
    return;
  }

  const startTime = parsedDates[0].start.date();
  console.log(`Parsed start time: ${startTime.toLocaleString()}`);

  // Get duration
  const durationInput = await Input.prompt({
    message: "Duration (e.g., 1h, 2h, 30m, 90m)",
    default: "1h",
  });

  // Parse duration
  const durationMatch = durationInput.match(/^(\d+(?:\.\d+)?)\s*(h|hours?|m|minutes?)?$/i);
  if (!durationMatch) {
    console.log(`❌ Invalid duration format: "${durationInput}"`);
    return;
  }

  const durationValue = parseFloat(durationMatch[1]);
  const durationUnit = durationMatch[2]?.toLowerCase() || "h";
  const durationMinutes = durationUnit.startsWith("h")
    ? durationValue * 60
    : durationValue;

  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  console.log(`End time: ${endTime.toLocaleString()}`);
  console.log(`Duration: ${durationMinutes} minutes (${durationMinutes / 60}h)\n`);

  // Get event name
  const eventName = await Input.prompt({
    message: "Event name (optional)",
    default: "Room booking",
  });

  // Calculate price
  const hours = durationMinutes / 60;
  const priceInfo = room.price
    .map((p) => `${(p.amount * hours).toFixed(2)} ${p.token}`)
    .join(" or ");

  // Confirm booking
  console.log("\n" + "=".repeat(60));
  console.log("Booking Summary:");
  console.log("=".repeat(60));
  console.log(`Room:     ${room.name}`);
  console.log(`Start:    ${startTime.toLocaleString()}`);
  console.log(`End:      ${endTime.toLocaleString()}`);
  console.log(`Duration: ${durationMinutes} minutes`);
  console.log(`Event:    ${eventName}`);
  console.log(`Price:    ${priceInfo}`);
  console.log("=".repeat(60) + "\n");

  const confirmed = await Confirm.prompt({
    message: "Confirm booking?",
    default: true,
  });

  if (!confirmed) {
    console.log("❌ Booking cancelled\n");
    return;
  }

  // Create calendar event
  try {
    console.log("\nCreating calendar event...");

    // Ensure calendar is in the list
    await calendarClient.ensureCalendarInList(room.calendarId!);

    const event = await calendarClient.createEvent(room.calendarId!, {
      summary: `${eventName} (${room.name})`,
      description: `Booked via CLI\nRoom: ${room.name}\nPrice: ${priceInfo}`,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });

    console.log("\n✅ Booking confirmed!");
    console.log(`Event ID: ${event.id}`);
    console.log(
      `View in Google Calendar: https://calendar.google.com\n`,
    );
  } catch (error: any) {
    console.error("\n❌ Failed to create booking:");

    if (error.conflictingEvent) {
      console.error(
        `\nConflict detected! There's already an event at this time:`,
      );
      console.error(`  Event: ${error.conflictingEvent.summary}`);
      console.error(
        `  Time:  ${error.conflictingEvent.start.dateTime} - ${error.conflictingEvent.end.dateTime}`,
      );
    } else {
      console.error(error.message);
    }
    console.log("");
  }
}

async function interactiveMode(
  guildId: string,
  guildName: string,
) {
  const calendarClient = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  console.log("\n" + "=".repeat(60));
  console.log(`Interactive Mode: ${guildName}`);
  console.log("=".repeat(60));
  console.log("Commands:");
  console.log("  /book  - Book a room");
  console.log("  /exit  - Exit interactive mode");
  console.log("  /help  - Show this help");
  console.log("=".repeat(60) + "\n");

  while (true) {
    const command = await Input.prompt({
      message: `${guildName} >`,
    });

    const trimmedCommand = command.trim().toLowerCase();

    if (trimmedCommand === "/exit" || trimmedCommand === "exit") {
      console.log("Goodbye! 👋\n");
      break;
    }

    if (trimmedCommand === "/help" || trimmedCommand === "help") {
      console.log("\nAvailable commands:");
      console.log("  /book  - Book a room with calendar integration");
      console.log("  /exit  - Exit interactive mode");
      console.log("  /help  - Show this help\n");
      continue;
    }

    if (trimmedCommand === "/book" || trimmedCommand === "book") {
      await handleBookCommand(guildId, calendarClient);
      continue;
    }

    if (trimmedCommand === "") {
      continue;
    }

    console.log(`❌ Unknown command: ${command}`);
    console.log('Type "/help" for available commands\n');
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║        Discord Bot CLI - Local Simulator           ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const guild = await selectGuild();
  if (!guild) {
    Deno.exit(1);
  }

  await interactiveMode(guild.id, guild.name);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Error:", error);
    Deno.exit(1);
  });
}
