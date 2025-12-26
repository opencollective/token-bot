/**
 * Demo script to list all calendars shared with the service account
 * and demonstrate the Google Calendar API functionality
 */

import { GoogleCalendarClient } from "../lib/googlecalendar.ts";

async function main() {
  console.log("Initializing Google Calendar Client...\n");

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  try {
    // List all calendars
    console.log("Fetching calendars shared with the service account...\n");
    console.log("Service account email: opencalendar@opencalendar-482019.iam.gserviceaccount.com\n");

    const calendars = await client.listCalendars();

    console.log(`Raw API response returned ${calendars.length} calendar(s)`);
    console.log("DEBUG - Full response:", JSON.stringify(calendars, null, 2));
    console.log("");

    if (calendars.length === 0) {
      console.log("No calendars found.");
      console.log(
        "\nTo share a calendar with this service account, go to Google Calendar settings",
      );
      console.log(
        "and share your calendar with: opencalendar@opencalendar-482019.iam.gserviceaccount.com",
      );
      console.log(
        "\nMake sure to:",
      );
      console.log("1. Share the calendar with the service account email");
      console.log("2. Give it at least 'See all event details' permission");
      console.log("3. Wait a minute or two after sharing for changes to propagate");
      return;
    }

    console.log(`Found ${calendars.length} calendar(s):\n`);
    console.log("=".repeat(80));

    for (const calendar of calendars) {
      console.log(`\nCalendar: ${calendar.summary}`);
      console.log(`ID: ${calendar.id}`);
      if (calendar.description) {
        console.log(`Description: ${calendar.description}`);
      }
      console.log(`Time Zone: ${calendar.timeZone || "Not specified"}`);
      console.log(`Access Role: ${calendar.accessRole || "Not specified"}`);
      console.log(`Primary: ${calendar.primary ? "Yes" : "No"}`);
      console.log("-".repeat(80));
    }

    console.log("\n=".repeat(80));
    console.log("\nCalendar listing completed successfully!");
  } catch (error) {
    console.error("Error:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
