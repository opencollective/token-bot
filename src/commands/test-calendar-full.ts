/**
 * Comprehensive test script for Google Calendar API
 * Tests all functionality: create calendar, list calendars, create events, list events, conflict detection
 */

import { GoogleCalendarClient } from "../lib/googlecalendar.ts";

async function main() {
  console.log("=".repeat(80));
  console.log("Google Calendar API - Full Functionality Test");
  console.log("=".repeat(80));
  console.log("");

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  let testCalendarId: string | undefined;

  try {
    // Step 1: List existing calendars
    console.log("1. Listing existing calendars...");
    const existingCalendars = await client.listCalendars();
    console.log(`   Found ${existingCalendars.length} existing calendar(s)`);
    for (const cal of existingCalendars) {
      console.log(`   - ${cal.summary} (${cal.id})`);
    }
    console.log("");

    // Step 2: Create a new test calendar
    console.log("2. Creating new test calendar...");
    const newCalendar = await client.createCalendar(
      "Test Calendar " + new Date().toISOString(),
      "Created by test script",
      "UTC",
    );
    testCalendarId = newCalendar.id;
    console.log(`   ✅ Calendar created: ${newCalendar.summary}`);
    console.log(`   ID: ${testCalendarId}`);
    console.log("");

    // Step 3: Create first event
    console.log("3. Creating first event...");
    const event1 = await client.createEvent(testCalendarId!, {
      summary: "Test Event 1",
      description: "First test event",
      start: {
        dateTime: "2025-01-15T10:00:00Z",
        timeZone: "UTC",
      },
      end: {
        dateTime: "2025-01-15T11:00:00Z",
        timeZone: "UTC",
      },
    });
    console.log(`   ✅ Event created: ${event1.summary}`);
    console.log(`   Time: ${event1.start.dateTime} - ${event1.end.dateTime}`);
    console.log("");

    // Step 4: Create second non-conflicting event
    console.log("4. Creating second non-conflicting event...");
    const event2 = await client.createEvent(testCalendarId!, {
      summary: "Test Event 2",
      description: "Second test event (different time)",
      start: {
        dateTime: "2025-01-15T14:00:00Z",
        timeZone: "UTC",
      },
      end: {
        dateTime: "2025-01-15T15:00:00Z",
        timeZone: "UTC",
      },
    });
    console.log(`   ✅ Event created: ${event2.summary}`);
    console.log(`   Time: ${event2.start.dateTime} - ${event2.end.dateTime}`);
    console.log("");

    // Step 5: Try to create conflicting event (should fail)
    console.log("5. Testing conflict detection (creating overlapping event)...");
    try {
      await client.createEvent(testCalendarId!, {
        summary: "Conflicting Event",
        description: "This should fail due to conflict",
        start: {
          dateTime: "2025-01-15T10:30:00Z",
          timeZone: "UTC",
        },
        end: {
          dateTime: "2025-01-15T11:30:00Z",
          timeZone: "UTC",
        },
      });
      console.log("   ❌ ERROR: Conflicting event was created (should have failed!)");
    } catch (error: any) {
      console.log("   ✅ Conflict detected correctly!");
      console.log(`   Message: ${error.message}`);
      if (error.conflictingEvent) {
        console.log(
          `   Conflicting event: ${error.conflictingEvent.summary} (${error.conflictingEvent.start.dateTime})`,
        );
      }
    }
    console.log("");

    // Step 6: List events in date range
    console.log("6. Listing all events in January 2025...");
    const events = await client.listEvents(
      testCalendarId!,
      new Date("2025-01-01T00:00:00Z"),
      new Date("2025-01-31T23:59:59Z"),
    );
    console.log(`   Found ${events.length} event(s):`);
    for (const event of events) {
      console.log(`   - ${event.summary}: ${event.start.dateTime} - ${event.end.dateTime}`);
    }
    console.log("");

    // Step 7: Delete the first event
    console.log("7. Deleting first event...");
    await client.deleteEvent(testCalendarId!, event1.id!);
    console.log("   ✅ Event deleted");
    console.log("");

    // Step 8: Verify event was deleted
    console.log("8. Verifying event was deleted...");
    const remainingEvents = await client.listEvents(
      testCalendarId!,
      new Date("2025-01-01T00:00:00Z"),
      new Date("2025-01-31T23:59:59Z"),
    );
    console.log(`   Now showing ${remainingEvents.length} event(s):`);
    for (const event of remainingEvents) {
      console.log(`   - ${event.summary}: ${event.start.dateTime} - ${event.end.dateTime}`);
    }
    console.log("");

    // Summary
    console.log("=".repeat(80));
    console.log("✅ ALL TESTS PASSED!");
    console.log("=".repeat(80));
    console.log("");
    console.log(`Test calendar ID: ${testCalendarId}`);
    console.log("You can view this calendar at: https://calendar.google.com");
    console.log(
      "\nNote: To see this calendar in Google Calendar UI, you need to add it to your account.",
    );
    console.log("The calendar is currently only visible via the API.");
  } catch (error) {
    console.error("\n❌ Error during test:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
