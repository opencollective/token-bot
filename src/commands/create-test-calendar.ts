/**
 * Script to create a test calendar owned by the service account
 * This can help verify the API is working
 */

import { GoogleCalendarClient } from "../lib/googlecalendar.ts";

async function main() {
  console.log("Creating test calendar owned by service account...\n");

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  try {
    const calendar = await client.createCalendar(
      "Test Calendar - OpenCalendar Bot",
      "Calendar created by service account for testing",
      "UTC",
    );

    console.log("✅ Calendar created successfully!\n");
    console.log("Calendar Details:");
    console.log("================");
    console.log(`Name: ${calendar.summary}`);
    console.log(`ID: ${calendar.id}`);
    console.log(`Description: ${calendar.description}`);
    console.log(`Time Zone: ${calendar.timeZone}`);
    console.log("");
    console.log(
      "This calendar is owned by the service account and should now appear in list-calendars.",
    );
    console.log("\nRun: deno task list-calendars");
  } catch (error) {
    console.error("❌ Error creating calendar:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
