/**
 * Unit tests for countEventsPerDay.
 * Run: deno test --allow-read --allow-write --allow-env tests/shifts.countEventsPerDay.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { countEventsPerDay } from "../src/commands/shifts.ts";
import type { GoogleCalendarClient } from "../src/lib/googlecalendar.ts";

// Mock calendar client
function createMockCalendar(eventsByCalendar: Record<string, any[]>): GoogleCalendarClient {
  return {
    listEvents: async (calendarId: string, _start: Date, _end: Date) => {
      return eventsByCalendar[calendarId] || [];
    },
  } as any as GoogleCalendarClient;
}

Deno.test("countEventsPerDay counts timed events correctly", async () => {
  const mock = createMockCalendar({
    "cal-1": [
      { summary: "Meeting", start: { dateTime: "2026-03-18T10:00:00+01:00" }, end: { dateTime: "2026-03-18T11:00:00+01:00" } },
      { summary: "Workshop", start: { dateTime: "2026-03-18T14:00:00+01:00" }, end: { dateTime: "2026-03-18T16:00:00+01:00" } },
      { summary: "Next day", start: { dateTime: "2026-03-19T09:00:00+01:00" }, end: { dateTime: "2026-03-19T10:00:00+01:00" } },
    ],
  });

  const start = new Date("2026-03-18T00:00:00+01:00");
  const end = new Date("2026-03-20T23:59:59+01:00");
  const counts = await countEventsPerDay(["cal-1"], start, end, mock);

  assertEquals(counts.get("2026-03-18"), 2, "Should have 2 events on Mar 18");
  assertEquals(counts.get("2026-03-19"), 1, "Should have 1 event on Mar 19");
  assertEquals(counts.has("2026-03-20"), false, "Should have no events on Mar 20");
});

Deno.test("countEventsPerDay counts all-day events (date field, no dateTime)", async () => {
  const mock = createMockCalendar({
    "cal-1": [
      // All-day event: has start.date but NOT start.dateTime
      { summary: "All Day Event", start: { date: "2026-03-18" }, end: { date: "2026-03-19" } },
      // Regular timed event
      { summary: "Timed", start: { dateTime: "2026-03-18T14:00:00+01:00" }, end: { dateTime: "2026-03-18T15:00:00+01:00" } },
    ],
  });

  const start = new Date("2026-03-18T00:00:00+01:00");
  const end = new Date("2026-03-19T23:59:59+01:00");
  const counts = await countEventsPerDay(["cal-1"], start, end, mock);

  assertEquals(counts.get("2026-03-18"), 2, "Should count both all-day and timed events");
});

Deno.test("countEventsPerDay aggregates across multiple calendars", async () => {
  const mock = createMockCalendar({
    "cal-ostrom": [
      { summary: "Ostrom event", start: { dateTime: "2026-03-18T10:00:00+01:00" }, end: { dateTime: "2026-03-18T11:00:00+01:00" } },
    ],
    "cal-satoshi": [
      { summary: "Satoshi event", start: { dateTime: "2026-03-18T14:00:00+01:00" }, end: { dateTime: "2026-03-18T16:00:00+01:00" } },
      { summary: "Satoshi event 2", start: { dateTime: "2026-03-19T10:00:00+01:00" }, end: { dateTime: "2026-03-19T11:00:00+01:00" } },
    ],
    "cal-mushroom": [
      { summary: "Mushroom event", start: { dateTime: "2026-03-18T09:00:00+01:00" }, end: { dateTime: "2026-03-18T10:00:00+01:00" } },
    ],
    "cal-coworking": [],
  });

  const start = new Date("2026-03-18T00:00:00+01:00");
  const end = new Date("2026-03-20T23:59:59+01:00");
  const counts = await countEventsPerDay(
    ["cal-ostrom", "cal-satoshi", "cal-mushroom", "cal-coworking"],
    start, end, mock,
  );

  assertEquals(counts.get("2026-03-18"), 3, "Should sum events across 3 calendars for Mar 18");
  assertEquals(counts.get("2026-03-19"), 1, "Should have 1 event on Mar 19");
});

Deno.test("countEventsPerDay handles calendar fetch errors gracefully", async () => {
  const mock = {
    listEvents: async (calendarId: string, _start: Date, _end: Date) => {
      if (calendarId === "cal-broken") throw new Error("API error");
      return [
        { summary: "Good event", start: { dateTime: "2026-03-18T10:00:00+01:00" }, end: { dateTime: "2026-03-18T11:00:00+01:00" } },
      ];
    },
  } as any as GoogleCalendarClient;

  const start = new Date("2026-03-18T00:00:00+01:00");
  const end = new Date("2026-03-19T23:59:59+01:00");
  const counts = await countEventsPerDay(["cal-broken", "cal-good"], start, end, mock);

  assertEquals(counts.get("2026-03-18"), 1, "Should still count events from working calendar");
});

Deno.test("countEventsPerDay skips events with no start info", async () => {
  const mock = createMockCalendar({
    "cal-1": [
      { summary: "No start", start: {}, end: {} },
      { summary: "Good", start: { dateTime: "2026-03-18T10:00:00+01:00" }, end: { dateTime: "2026-03-18T11:00:00+01:00" } },
    ],
  });

  const start = new Date("2026-03-18T00:00:00+01:00");
  const end = new Date("2026-03-19T23:59:59+01:00");
  const counts = await countEventsPerDay(["cal-1"], start, end, mock);

  assertEquals(counts.get("2026-03-18"), 1, "Should skip event with no date/dateTime");
});

Deno.test("countEventsPerDay returns empty map for no events", async () => {
  const mock = createMockCalendar({ "cal-1": [] });

  const start = new Date("2026-03-18T00:00:00+01:00");
  const end = new Date("2026-03-19T23:59:59+01:00");
  const counts = await countEventsPerDay(["cal-1"], start, end, mock);

  assertEquals(counts.size, 0, "Should be empty for no events");
});
