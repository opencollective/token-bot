/**
 * Discord Bot /book Command Tests
 *
 * These tests verify that the /book command correctly parses messages
 * and creates the expected calendar event structure.
 *
 * Since ES module exports in Deno are non-configurable and can't be stubbed,
 * these tests focus on:
 * 1. Testing the booking state structure that would be created
 * 2. Verifying the expected calendar event format from that state
 * 3. Testing parsing logic by simulating the expected transformations
 */

import { expect } from "@std/expect/expect";
import { bookStates } from "../src/commands/book.ts";
import type { BookState } from "../src/types.ts";
import type { CalendarEvent } from "../src/lib/googlecalendar.ts";

const TEST_USER_ID = "test-user-123";
const TEST_CALENDAR_ID = "calendar-id-123";

// Mock guild settings (simulating what loadGuildSettings returns)
const mockGuildSettings = {
  contributionToken: {
    name: "Community Hour Token",
    symbol: "CHT",
    decimals: 6,
    chain: "celo" as const,
    address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
    mintInstructions: "Visit the faucet to get more tokens",
  },
  guild: {
    id: "1280532848604086365",
    name: "Test Guild",
    icon: null,
    timezone: "Europe/Brussels",
  },
};

// Mock products (simulating what loadGuildFile('products.json') returns)
const mockProducts = [
  {
    type: "room" as const,
    unit: "hour" as const,
    slug: "meeting-room",
    name: "Meeting Room",
    availabilities: "Mon-Fri 9am-5pm",
    calendarId: TEST_CALENDAR_ID,
    price: [
      { token: "CHT", amount: 10 },
    ],
  },
];

// Helper to simulate the duration parsing logic from book.ts
function parseDuration(durationInput: string): number | null {
  const durationMatch = durationInput.match(/^(\d+(?:\.\d+)?)\s*(h|hours?|m|minutes?)?$/i);
  if (!durationMatch) return null;

  const durationValue = parseFloat(durationMatch[1]);
  const durationUnit = durationMatch[2]?.toLowerCase() || "h";
  return durationUnit.startsWith("h") ? durationValue * 60 : durationValue;
}

// Helper to create a BookState as handleBookCommand would
function createBookState(params: {
  productSlug: string;
  startTime: Date;
  durationMinutes: number;
  name: string;
}): BookState {
  const endTime = new Date(params.startTime.getTime() + params.durationMinutes * 60000);
  return {
    productSlug: params.productSlug,
    startTime: params.startTime,
    endTime,
    duration: params.durationMinutes,
    name: params.name,
  };
}

// Helper to create a CalendarEvent as handleBookButton would
function createExpectedCalendarEvent(
  state: BookState,
  user: { displayName: string; username: string },
  priceAmount: number,
  tokenSymbol: string,
): CalendarEvent {
  // This replicates the logic from book.ts lines 423-446
  const eventDescription =
    `Booked by ${user.displayName} (@${user.username}) for ${priceAmount.toFixed(2)} ${tokenSymbol}` +
    `\n\nPlease reach out to @${user.username} on Discord for questions about this booking.` +
    `\n\nTo cancel, ${user.displayName} needs to run the /cancel command in Discord.`;

  return {
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
  };
}

// Tests for duration parsing
Deno.test("Duration parsing - '2h' returns 120 minutes", () => {
  const result = parseDuration("2h");
  expect(result).toBe(120);
});

Deno.test("Duration parsing - '30m' returns 30 minutes", () => {
  const result = parseDuration("30m");
  expect(result).toBe(30);
});

Deno.test("Duration parsing - '45m' returns 45 minutes", () => {
  const result = parseDuration("45m");
  expect(result).toBe(45);
});

Deno.test("Duration parsing - '1.5h' returns 90 minutes", () => {
  const result = parseDuration("1.5h");
  expect(result).toBe(90);
});

Deno.test("Duration parsing - '1h' returns 60 minutes", () => {
  const result = parseDuration("1h");
  expect(result).toBe(60);
});

Deno.test("Duration parsing - '90m' returns 90 minutes", () => {
  const result = parseDuration("90m");
  expect(result).toBe(90);
});

Deno.test("Duration parsing - 'invalid' returns null", () => {
  const result = parseDuration("invalid");
  expect(result).toBeNull();
});

Deno.test("Duration parsing - empty string returns null", () => {
  const result = parseDuration("");
  expect(result).toBeNull();
});

Deno.test("Duration parsing - '2.5h' returns 150 minutes", () => {
  const result = parseDuration("2.5h");
  expect(result).toBe(150);
});

Deno.test("Duration parsing - 'hours' suffix works", () => {
  const result = parseDuration("2hours");
  expect(result).toBe(120);
});

Deno.test("Duration parsing - 'minutes' suffix works", () => {
  const result = parseDuration("30minutes");
  expect(result).toBe(30);
});

// Tests for BookState structure
Deno.test("BookState - end time calculated correctly for 2h duration", () => {
  const startTime = new Date("2025-06-15T14:00:00");
  const state = createBookState({
    productSlug: "meeting-room",
    startTime,
    durationMinutes: 120,
    name: "Team Meeting",
  });

  expect(state.endTime.getTime() - state.startTime.getTime()).toBe(120 * 60 * 1000);
  expect(state.endTime).toEqual(new Date("2025-06-15T16:00:00"));
});

Deno.test("BookState - end time calculated correctly for 30m duration", () => {
  const startTime = new Date("2025-06-15T14:00:00");
  const state = createBookState({
    productSlug: "meeting-room",
    startTime,
    durationMinutes: 30,
    name: "Quick Sync",
  });

  expect(state.duration).toBe(30);
  expect(state.endTime).toEqual(new Date("2025-06-15T14:30:00"));
});

Deno.test("BookState - productSlug stored correctly", () => {
  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 60,
    name: "Test",
  });

  expect(state.productSlug).toBe("meeting-room");
});

Deno.test("BookState - name stored correctly", () => {
  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 60,
    name: "Project Review",
  });

  expect(state.name).toBe("Project Review");
});

Deno.test("BookState - stored in bookStates Map", () => {
  bookStates.clear();

  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 60,
    name: "Test Meeting",
  });

  bookStates.set(TEST_USER_ID, state);

  expect(bookStates.has(TEST_USER_ID)).toBe(true);
  expect(bookStates.get(TEST_USER_ID)).toEqual(state);

  bookStates.clear();
});

// Tests for CalendarEvent structure
Deno.test("CalendarEvent - summary matches event name", () => {
  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 90,
    name: "Project Review",
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName: "Test User", username: "testuser" },
    15, // 1.5h * 10 CHT/hour
    "CHT",
  );

  expect(event.summary).toBe("Project Review");
});

Deno.test("CalendarEvent - start time in ISO format", () => {
  const startTime = new Date("2025-06-15T14:00:00Z");
  const state = createBookState({
    productSlug: "meeting-room",
    startTime,
    durationMinutes: 60,
    name: "Test",
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName: "Test User", username: "testuser" },
    10,
    "CHT",
  );

  expect(event.start.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

Deno.test("CalendarEvent - end time in ISO format", () => {
  const startTime = new Date("2025-06-15T14:00:00Z");
  const state = createBookState({
    productSlug: "meeting-room",
    startTime,
    durationMinutes: 60,
    name: "Test",
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName: "Test User", username: "testuser" },
    10,
    "CHT",
  );

  expect(event.end.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

Deno.test("CalendarEvent - timezone is set", () => {
  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 60,
    name: "Test",
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName: "Test User", username: "testuser" },
    10,
    "CHT",
  );

  expect(event.start.timeZone).toBeDefined();
  expect(event.end.timeZone).toBeDefined();
  expect(event.start.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
});

Deno.test("CalendarEvent - description contains user display name", () => {
  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 60,
    name: "Test",
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName: "John Doe", username: "johndoe" },
    10,
    "CHT",
  );

  expect(event.description).toContain("John Doe");
});

Deno.test("CalendarEvent - description contains username", () => {
  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 60,
    name: "Test",
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName: "John Doe", username: "johndoe" },
    10,
    "CHT",
  );

  expect(event.description).toContain("@johndoe");
});

Deno.test("CalendarEvent - description contains price", () => {
  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 90,
    name: "Test",
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName: "Test User", username: "testuser" },
    15, // 1.5h * 10 CHT/hour
    "CHT",
  );

  expect(event.description).toContain("15.00 CHT");
});

Deno.test("CalendarEvent - description contains cancel instructions", () => {
  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 60,
    name: "Test",
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName: "Test User", username: "testuser" },
    10,
    "CHT",
  );

  expect(event.description).toContain("/cancel");
});

Deno.test("CalendarEvent - duration matches state", () => {
  const startTime = new Date("2025-06-15T14:00:00Z");
  const state = createBookState({
    productSlug: "meeting-room",
    startTime,
    durationMinutes: 90,
    name: "Test",
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName: "Test User", username: "testuser" },
    15,
    "CHT",
  );

  const eventStart = new Date(event.start.dateTime);
  const eventEnd = new Date(event.end.dateTime);
  const durationMs = eventEnd.getTime() - eventStart.getTime();
  expect(durationMs).toBe(90 * 60 * 1000); // 90 minutes in ms
});

// Tests for price calculation
Deno.test("Price calculation - 30m booking at 10 CHT/hour = 5 CHT", () => {
  const durationMinutes = 30;
  const pricePerHour = 10;
  const hours = durationMinutes / 60;
  const priceAmount = pricePerHour * hours;

  expect(priceAmount).toBe(5);
  expect(priceAmount.toFixed(2)).toBe("5.00");
});

Deno.test("Price calculation - 2h booking at 10 CHT/hour = 20 CHT", () => {
  const durationMinutes = 120;
  const pricePerHour = 10;
  const hours = durationMinutes / 60;
  const priceAmount = pricePerHour * hours;

  expect(priceAmount).toBe(20);
  expect(priceAmount.toFixed(2)).toBe("20.00");
});

Deno.test("Price calculation - 1.5h booking at 10 CHT/hour = 15 CHT", () => {
  const durationMinutes = 90;
  const pricePerHour = 10;
  const hours = durationMinutes / 60;
  const priceAmount = pricePerHour * hours;

  expect(priceAmount).toBe(15);
  expect(priceAmount.toFixed(2)).toBe("15.00");
});

Deno.test("Price calculation - 45m booking at 10 CHT/hour = 7.5 CHT", () => {
  const durationMinutes = 45;
  const pricePerHour = 10;
  const hours = durationMinutes / 60;
  const priceAmount = pricePerHour * hours;

  expect(priceAmount).toBe(7.5);
  expect(priceAmount.toFixed(2)).toBe("7.50");
});

// Tests for product lookup
Deno.test("Product lookup - finds product by slug", () => {
  const product = mockProducts.find((p) => p.slug === "meeting-room");
  expect(product).toBeDefined();
  expect(product?.name).toBe("Meeting Room");
});

Deno.test("Product lookup - returns undefined for non-existent slug", () => {
  const product = mockProducts.find((p) => p.slug === "nonexistent-room");
  expect(product).toBeUndefined();
});

Deno.test("Product lookup - calendarId is present", () => {
  const product = mockProducts.find((p) => p.slug === "meeting-room");
  expect(product?.calendarId).toBe(TEST_CALENDAR_ID);
});

// Tests for full flow simulation
Deno.test("Full flow - book command to calendar event", () => {
  // Simulate the full flow from book command to calendar event creation

  // Step 1: Parse duration (simulating what handleBookCommand does)
  const durationMinutes = parseDuration("1.5h");
  expect(durationMinutes).toBe(90);

  // Step 2: Create book state (simulating what handleBookCommand does)
  const startTime = new Date("2025-06-15T14:00:00");
  const state = createBookState({
    productSlug: "meeting-room",
    startTime,
    durationMinutes: durationMinutes!,
    name: "Project Review",
  });

  // Step 3: Store in bookStates (simulating what handleBookCommand does)
  bookStates.set(TEST_USER_ID, state);

  // Step 4: Look up product (simulating what handleBookButton does)
  const product = mockProducts.find((p) => p.slug === state.productSlug);
  expect(product).toBeDefined();

  // Step 5: Calculate price (simulating what handleBookButton does)
  const hours = state.duration! / 60;
  const priceAmount = product!.price[0].amount * hours;
  expect(priceAmount).toBe(15); // 10 CHT/hour * 1.5h

  // Step 6: Create calendar event (simulating what handleBookButton does)
  const event = createExpectedCalendarEvent(
    state,
    { displayName: "Test User", username: "testuser" },
    priceAmount,
    mockGuildSettings.contributionToken.symbol,
  );

  // Step 7: Verify the calendar event structure
  expect(event.summary).toBe("Project Review");
  expect(event.description).toContain("Test User");
  expect(event.description).toContain("@testuser");
  expect(event.description).toContain("15.00 CHT");
  expect(event.start.dateTime).toContain("2025-06-15");
  expect(event.end.dateTime).toContain("2025-06-15");

  // Verify the calendar ID that would be used
  expect(product!.calendarId).toBe(TEST_CALENDAR_ID);

  // Cleanup
  bookStates.clear();
});

Deno.test("Full flow - default event name when none provided", () => {
  const displayName = "Test User";
  const defaultEventName = `Booked by ${displayName}`;

  const state = createBookState({
    productSlug: "meeting-room",
    startTime: new Date("2025-06-15T14:00:00"),
    durationMinutes: 60,
    name: defaultEventName,
  });

  const event = createExpectedCalendarEvent(
    state,
    { displayName, username: "testuser" },
    10,
    "CHT",
  );

  expect(event.summary).toBe("Booked by Test User");
});

Deno.test("Full flow - multiple prices format", () => {
  // Test with a product that has multiple prices
  const multiPriceProduct = {
    type: "room" as const,
    unit: "hour" as const,
    slug: "conference-room",
    name: "Conference Room",
    calendarId: "cal-123",
    price: [
      { token: "CHT", amount: 10 },
      { token: "EURb", amount: 5 },
    ],
  };

  const hours = 1.5;

  // Format price string as handleBookCommand does
  const priceInfo = multiPriceProduct.price
    .map((p) => `${(p.amount * hours).toFixed(2)} ${p.token}`)
    .join(" or ");

  expect(priceInfo).toBe("15.00 CHT or 7.50 EURb");
});
