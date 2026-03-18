/**
 * Tests for room-events-cache.
 * Run: deno test --allow-read --allow-write --allow-env tests/room-events-cache.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { getEventsForDateRange, toDateKey, fromDateKey } from "../src/lib/room-events-cache.ts";
import type { GoogleCalendarClient } from "../src/lib/googlecalendar.ts";

function mockCalendar(eventsByCalendar: Record<string, any[]>): GoogleCalendarClient {
  return {
    listEvents: async (calendarId: string) => eventsByCalendar[calendarId] || [],
  } as any;
}

// --- toDateKey / fromDateKey ---

Deno.test("toDateKey formats correctly", () => {
  assertEquals(toDateKey(new Date(2026, 2, 18)), "20260318"); // March = 2
  assertEquals(toDateKey(new Date(2026, 0, 5)), "20260105");  // Jan 5
});

Deno.test("fromDateKey parses correctly", () => {
  const d = fromDateKey("20260318");
  assertEquals(d.getFullYear(), 2026);
  assertEquals(d.getMonth(), 2); // March
  assertEquals(d.getDate(), 18);
});

Deno.test("toDateKey and fromDateKey roundtrip", () => {
  const original = new Date(2026, 11, 25); // Dec 25
  const key = toDateKey(original);
  const back = fromDateKey(key);
  assertEquals(back.getFullYear(), original.getFullYear());
  assertEquals(back.getMonth(), original.getMonth());
  assertEquals(back.getDate(), original.getDate());
});

// --- getEventsForDateRange ---

Deno.test("getEventsForDateRange groups timed events by date", async () => {
  const calIdToRoom = new Map([["cal-ostrom", "ostrom"]]);
  const mock = mockCalendar({
    "cal-ostrom": [
      { summary: "Morning standup", start: { dateTime: "2026-03-18T09:00:00+01:00" }, end: { dateTime: "2026-03-18T09:30:00+01:00" } },
      { summary: "Workshop", start: { dateTime: "2026-03-18T14:00:00+01:00" }, end: { dateTime: "2026-03-18T16:00:00+01:00" } },
      { summary: "Next day event", start: { dateTime: "2026-03-19T10:00:00+01:00" }, end: { dateTime: "2026-03-19T11:00:00+01:00" } },
    ],
  });

  const result = await getEventsForDateRange(
    new Date("2026-03-18"), new Date("2026-03-20"),
    ["cal-ostrom"], calIdToRoom, mock,
  );

  assertEquals(result.get("20260318")?.length, 2);
  assertEquals(result.get("20260319")?.length, 1);
  assertEquals(result.has("20260320"), false);

  // Check event structure
  const mar18 = result.get("20260318")!;
  assertEquals(mar18[0].title, "Morning standup");
  assertEquals(mar18[0].room, "ostrom");
  assertEquals(mar18[1].title, "Workshop");
});

Deno.test("getEventsForDateRange handles all-day events", async () => {
  const calIdToRoom = new Map([["cal-1", "room1"]]);
  const mock = mockCalendar({
    "cal-1": [
      { summary: "All-day retreat", start: { date: "2026-03-18" }, end: { date: "2026-03-19" } },
      { summary: "Timed event", start: { dateTime: "2026-03-18T14:00:00+01:00" }, end: { dateTime: "2026-03-18T15:00:00+01:00" } },
    ],
  });

  const result = await getEventsForDateRange(
    new Date("2026-03-18"), new Date("2026-03-19"),
    ["cal-1"], calIdToRoom, mock,
  );

  assertEquals(result.get("20260318")?.length, 2);
  assertEquals(result.get("20260318")![0].title, "All-day retreat");
});

Deno.test("getEventsForDateRange aggregates across multiple calendars", async () => {
  const calIdToRoom = new Map([
    ["cal-ostrom", "ostrom"],
    ["cal-satoshi", "satoshi"],
    ["cal-mushroom", "mushroom"],
    ["cal-coworking", "coworking"],
  ]);
  const mock = mockCalendar({
    "cal-ostrom": [
      { summary: "Ostrom meeting", start: { dateTime: "2026-03-18T10:00:00+01:00" }, end: { dateTime: "2026-03-18T11:00:00+01:00" } },
    ],
    "cal-satoshi": [
      { summary: "Satoshi workshop", start: { dateTime: "2026-03-18T14:00:00+01:00" }, end: { dateTime: "2026-03-18T16:00:00+01:00" } },
      { summary: "Satoshi call", start: { dateTime: "2026-03-19T09:00:00+01:00" }, end: { dateTime: "2026-03-19T10:00:00+01:00" } },
    ],
    "cal-mushroom": [
      { summary: "Mushroom session", start: { dateTime: "2026-03-18T09:00:00+01:00" }, end: { dateTime: "2026-03-18T10:00:00+01:00" } },
    ],
    "cal-coworking": [],
  });

  const result = await getEventsForDateRange(
    new Date("2026-03-18"), new Date("2026-03-20"),
    ["cal-ostrom", "cal-satoshi", "cal-mushroom", "cal-coworking"],
    calIdToRoom, mock,
  );

  assertEquals(result.get("20260318")?.length, 3);
  assertEquals(result.get("20260319")?.length, 1);
  
  // Verify room names are correct
  const rooms = result.get("20260318")!.map(e => e.room).sort();
  assertEquals(rooms, ["mushroom", "ostrom", "satoshi"]);
});

Deno.test("getEventsForDateRange handles calendar errors gracefully", async () => {
  const calIdToRoom = new Map([["cal-broken", "broken"], ["cal-good", "good"]]);
  const mock = {
    listEvents: async (calendarId: string) => {
      if (calendarId === "cal-broken") throw new Error("API error");
      return [
        { summary: "Good event", start: { dateTime: "2026-03-18T10:00:00+01:00" }, end: { dateTime: "2026-03-18T11:00:00+01:00" } },
      ];
    },
  } as any;

  const result = await getEventsForDateRange(
    new Date("2026-03-18"), new Date("2026-03-19"),
    ["cal-broken", "cal-good"], calIdToRoom, mock,
  );

  assertEquals(result.get("20260318")?.length, 1);
  assertEquals(result.get("20260318")![0].room, "good");
});

Deno.test("getEventsForDateRange skips events with no start", async () => {
  const mock = mockCalendar({
    "cal-1": [
      { summary: "No start", start: {}, end: {} },
      { summary: "Good", start: { dateTime: "2026-03-18T10:00:00+01:00" }, end: { dateTime: "2026-03-18T11:00:00+01:00" } },
    ],
  });

  const result = await getEventsForDateRange(
    new Date("2026-03-18"), new Date("2026-03-19"),
    ["cal-1"], new Map([["cal-1", "room"]]), mock,
  );

  assertEquals(result.get("20260318")?.length, 1);
});

Deno.test("getEventsForDateRange returns empty map for no events", async () => {
  const mock = mockCalendar({ "cal-1": [] });
  const result = await getEventsForDateRange(
    new Date("2026-03-18"), new Date("2026-03-19"),
    ["cal-1"], new Map(), mock,
  );
  assertEquals(result.size, 0);
});

Deno.test("getEventsForDateRange preserves full event details", async () => {
  const calIdToRoom = new Map([["cal-1", "ostrom"]]);
  const mock = mockCalendar({
    "cal-1": [
      {
        summary: "Team lunch",
        start: { dateTime: "2026-03-18T12:00:00+01:00" },
        end: { dateTime: "2026-03-18T13:00:00+01:00" },
      },
    ],
  });

  const result = await getEventsForDateRange(
    new Date("2026-03-18"), new Date("2026-03-19"),
    ["cal-1"], calIdToRoom, mock,
  );

  const ev = result.get("20260318")![0];
  assertEquals(ev.title, "Team lunch");
  assertEquals(ev.room, "ostrom");
  assertEquals(ev.start, "2026-03-18T12:00:00+01:00");
  assertEquals(ev.end, "2026-03-18T13:00:00+01:00");
});
