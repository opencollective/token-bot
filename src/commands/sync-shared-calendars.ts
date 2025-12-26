/**
 * Script to sync all shared calendars to the service account's calendar list
 * Run this once after someone shares calendars with the service account
 */

import { GoogleCalendarClient } from "../lib/googlecalendar.ts";

async function main() {
  console.log("=".repeat(80));
  console.log("Sync Shared Calendars to Service Account");
  console.log("=".repeat(80));
  console.log("");
  console.log(
    "This script helps you add shared calendars that don't appear in list-calendars",
  );
  console.log("");

  const calendarIds = Deno.args;

  if (calendarIds.length === 0) {
    console.log("Usage: deno task sync-calendars <calendar-id-1> [calendar-id-2] ...");
    console.log("");
    console.log("Examples:");
    console.log("  deno task sync-calendars myemail@gmail.com");
    console.log("  deno task sync-calendars cal1@gmail.com cal2@example.com");
    console.log("");
    console.log("To find calendar IDs:");
    console.log("  1. Go to calendar.google.com");
    console.log("  2. Click the 3 dots next to your calendar");
    console.log('  3. Settings and sharing → "Integrate calendar"');
    console.log('  4. Copy the "Calendar ID"');
    console.log("");
    Deno.exit(1);
  }

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  console.log(`Processing ${calendarIds.length} calendar(s)...\n`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const calendarId of calendarIds) {
    try {
      console.log(`\n📅 Processing: ${calendarId}`);

      // Check if already in list
      const inList = await client.isCalendarInList(calendarId);

      if (inList) {
        console.log("   ℹ️  Already in calendar list (skipping)");
        skipCount++;
        continue;
      }

      // Try to get calendar info first (verifies we have access)
      const calendarInfo = await client.getCalendar(calendarId);
      console.log(`   ✓ Can access: ${calendarInfo.summary}`);

      // Add to calendar list
      await client.addCalendarToList(calendarId);
      console.log("   ✓ Added to calendar list");

      successCount++;
    } catch (error: any) {
      console.log(`   ❌ Error: ${error.message}`);

      if (error.message.includes("404")) {
        console.log(
          "      → Calendar not found or not shared with service account",
        );
      } else if (error.message.includes("403")) {
        console.log(
          "      → Permission denied - check sharing settings",
        );
      }

      errorCount++;
    }
  }

  console.log("");
  console.log("=".repeat(80));
  console.log("Summary:");
  console.log(`  ✅ Successfully added: ${successCount}`);
  console.log(`  ℹ️  Already in list:   ${skipCount}`);
  console.log(`  ❌ Errors:             ${errorCount}`);
  console.log("=".repeat(80));

  if (successCount > 0) {
    console.log("");
    console.log("Run: deno task list-calendars");
    console.log("The new calendars should now appear!");
  }

  if (errorCount > 0) {
    console.log("");
    console.log("For calendars with errors:");
    console.log("1. Verify the calendar ID is correct");
    console.log("2. Check that the calendar is shared with:");
    console.log("   opencalendar@opencalendar-482019.iam.gserviceaccount.com");
    console.log('3. Permission level should be "See all event details" or higher');
  }
}

if (import.meta.main) {
  main();
}
