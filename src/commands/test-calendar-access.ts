/**
 * Test script to check if we can access a specific calendar by ID
 * and diagnose permission issues
 */

import { GoogleCalendarClient } from "../lib/googlecalendar.ts";
import { google } from "googleapis";

async function main() {
  const args = Deno.args;

  if (args.length === 0) {
    console.log("Usage: deno task test-calendar-access <calendar-id>");
    console.log("");
    console.log("To find your calendar ID:");
    console.log("1. Go to Google Calendar settings");
    console.log("2. Click on your calendar");
    console.log('3. Scroll to "Integrate calendar"');
    console.log('4. Copy the "Calendar ID" (usually looks like an email)');
    console.log("");
    console.log("Example:");
    console.log("  deno task test-calendar-access your-email@gmail.com");
    Deno.exit(1);
  }

  const calendarId = args[0];

  console.log("=".repeat(80));
  console.log("Testing Calendar Access");
  console.log("=".repeat(80));
  console.log(`Calendar ID: ${calendarId}`);
  console.log(
    `Service Account: opencalendar@opencalendar-482019.iam.gserviceaccount.com`,
  );
  console.log("");

  // Initialize auth
  const auth = new google.auth.GoogleAuth({
    keyFile: "./google-account-key.json",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const calendar = google.calendar({ version: "v3", auth });

  try {
    // Test 1: Try to get calendar metadata
    console.log("Test 1: Getting calendar metadata...");
    try {
      const calendarResponse = await calendar.calendars.get({
        calendarId,
      });
      console.log("✅ Can access calendar metadata");
      console.log(`   Name: ${calendarResponse.data.summary}`);
      console.log(`   Description: ${calendarResponse.data.description || "N/A"}`);
      console.log(`   Time Zone: ${calendarResponse.data.timeZone}`);
      console.log("");
    } catch (error: any) {
      console.log("❌ Cannot access calendar metadata");
      console.log(`   Error: ${error.message}`);
      if (error.message.includes("404")) {
        console.log("   → Calendar not found or not shared with service account");
      } else if (error.message.includes("403")) {
        console.log("   → Permission denied - calendar may not be shared with correct permissions");
      }
      console.log("");
    }

    // Test 2: Try to list events
    console.log("Test 2: Listing events...");
    try {
      const now = new Date();
      const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const oneMonthLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const eventsResponse = await calendar.events.list({
        calendarId,
        timeMin: oneMonthAgo.toISOString(),
        timeMax: oneMonthLater.toISOString(),
        maxResults: 10,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = eventsResponse.data.items || [];
      console.log(`✅ Can list events (found ${events.length} events)`);

      if (events.length > 0) {
        console.log("   Recent events:");
        events.slice(0, 5).forEach((event: any) => {
          const start = event.start?.dateTime || event.start?.date;
          console.log(`   - ${event.summary} (${start})`);
        });
      }
      console.log("");
    } catch (error: any) {
      console.log("❌ Cannot list events");
      console.log(`   Error: ${error.message}`);
      console.log("");
    }

    // Test 3: Check if calendar is in calendarList
    console.log("Test 3: Checking if calendar is in service account's calendar list...");
    try {
      const listResponse = await calendar.calendarList.list();
      const calendars = listResponse.data.items || [];
      const found = calendars.find((cal: any) => cal.id === calendarId);

      if (found) {
        console.log("✅ Calendar IS in the calendar list");
        console.log(`   Access Role: ${found.accessRole}`);
        console.log(`   Selected: ${found.selected}`);
      } else {
        console.log("⚠️  Calendar is NOT in the calendar list");
        console.log("   This is why list-calendars doesn't show it!");
        console.log("");
        console.log("   Solution: Add the calendar to the service account's list");
      }
      console.log("");
    } catch (error: any) {
      console.log("❌ Error checking calendar list");
      console.log(`   Error: ${error.message}`);
      console.log("");
    }

    // Test 4: Try to add calendar to list
    console.log("Test 4: Attempting to add calendar to service account's calendar list...");
    try {
      await calendar.calendarList.insert({
        requestBody: {
          id: calendarId,
        },
      });
      console.log("✅ Successfully added calendar to calendar list!");
      console.log("");
      console.log("Now run: deno task list-calendars");
      console.log("The calendar should now appear in the list.");
    } catch (error: any) {
      console.log("⚠️  Could not add calendar to list");
      console.log(`   Error: ${error.message}`);

      if (error.message.includes("403") || error.message.includes("404")) {
        console.log("");
        console.log("This usually means:");
        console.log(
          "1. The calendar is not shared with the service account, OR",
        );
        console.log("2. The service account doesn't have sufficient permissions");
        console.log("");
        console.log("Make sure the calendar is shared with:");
        console.log("   opencalendar@opencalendar-482019.iam.gserviceaccount.com");
        console.log('With at least "See all event details" permission');
      }
    }

    console.log("");
    console.log("=".repeat(80));
  } catch (error) {
    console.error("Unexpected error:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
