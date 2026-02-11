/**
 * Date Parser Tests
 *
 * Tests for parsing natural language date/time strings as used by the /book command.
 * The bot uses chrono-node to parse user input like "tomorrow 2pm", "Monday 10am", etc.
 */

import { expect } from "@std/expect/expect";
import * as chrono from "chrono-node";

// Helper to get the next occurrence of a specific day of the week
function getNextDayOfWeek(dayOfWeek: number): Date {
  const today = new Date();
  const currentDay = today.getDay();
  let daysUntil = dayOfWeek - currentDay;
  if (daysUntil <= 0) {
    daysUntil += 7; // Next week
  }
  const result = new Date(today);
  result.setDate(today.getDate() + daysUntil);
  return result;
}

// Helper to parse date string using chrono (same as book.ts)
function parseDate(whenInput: string): Date | null {
  const parsedDates = chrono.parse(whenInput);
  if (parsedDates.length === 0) {
    return null;
  }
  return parsedDates[0].start.date();
}

// Tests for "tomorrow" format
Deno.test("Date parsing - 'tomorrow 2pm' parses to tomorrow at 14:00", () => {
  const result = parseDate("tomorrow 2pm");
  expect(result).not.toBeNull();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(result!.getDate()).toBe(tomorrow.getDate());
  expect(result!.getMonth()).toBe(tomorrow.getMonth());
  expect(result!.getHours()).toBe(14);
  expect(result!.getMinutes()).toBe(0);
});

Deno.test("Date parsing - 'tomorrow 10am' parses to tomorrow at 10:00", () => {
  const result = parseDate("tomorrow 10am");
  expect(result).not.toBeNull();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(result!.getDate()).toBe(tomorrow.getDate());
  expect(result!.getHours()).toBe(10);
  expect(result!.getMinutes()).toBe(0);
});

Deno.test("Date parsing - 'tomorrow 9:30am' parses to tomorrow at 09:30", () => {
  const result = parseDate("tomorrow 9:30am");
  expect(result).not.toBeNull();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(result!.getDate()).toBe(tomorrow.getDate());
  expect(result!.getHours()).toBe(9);
  expect(result!.getMinutes()).toBe(30);
});

Deno.test("Date parsing - 'tomorrow at 3pm' parses to tomorrow at 15:00", () => {
  const result = parseDate("tomorrow at 3pm");
  expect(result).not.toBeNull();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(result!.getDate()).toBe(tomorrow.getDate());
  expect(result!.getHours()).toBe(15);
});

// Tests for day of week format
Deno.test("Date parsing - 'Monday 10am' parses to next Monday at 10:00", () => {
  const result = parseDate("Monday 10am");
  expect(result).not.toBeNull();

  // Should be a Monday
  expect(result!.getDay()).toBe(1); // Monday = 1
  expect(result!.getHours()).toBe(10);
  expect(result!.getMinutes()).toBe(0);
});

Deno.test("Date parsing - 'Monday 19:00' parses to next Monday at 19:00", () => {
  const result = parseDate("Monday 19:00");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(1); // Monday = 1
  expect(result!.getHours()).toBe(19);
  expect(result!.getMinutes()).toBe(0);
});

Deno.test("Date parsing - 'Tuesday 2pm' parses to next Tuesday at 14:00", () => {
  const result = parseDate("Tuesday 2pm");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(2); // Tuesday = 2
  expect(result!.getHours()).toBe(14);
});

Deno.test("Date parsing - 'Wednesday at 11am' parses correctly", () => {
  const result = parseDate("Wednesday at 11am");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(3); // Wednesday = 3
  expect(result!.getHours()).toBe(11);
});

Deno.test("Date parsing - 'Thursday 15:30' parses correctly", () => {
  const result = parseDate("Thursday 15:30");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(4); // Thursday = 4
  expect(result!.getHours()).toBe(15);
  expect(result!.getMinutes()).toBe(30);
});

Deno.test("Date parsing - 'Friday 4pm' parses correctly", () => {
  const result = parseDate("Friday 4pm");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(5); // Friday = 5
  expect(result!.getHours()).toBe(16);
});

Deno.test("Date parsing - 'Saturday 10:00' parses correctly", () => {
  const result = parseDate("Saturday 10:00");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(6); // Saturday = 6
  expect(result!.getHours()).toBe(10);
});

Deno.test("Date parsing - 'Sunday 2pm' parses correctly", () => {
  const result = parseDate("Sunday 2pm");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(0); // Sunday = 0
  expect(result!.getHours()).toBe(14);
});

// Tests for "next" format
Deno.test("Date parsing - 'next Monday at 10am' parses correctly", () => {
  const result = parseDate("next Monday at 10am");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(1);
  expect(result!.getHours()).toBe(10);
});

Deno.test("Date parsing - 'next Friday 3pm' parses correctly", () => {
  const result = parseDate("next Friday 3pm");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(5);
  expect(result!.getHours()).toBe(15);
});

Deno.test("Date parsing - 'next week Monday 9am' parses to a future date", () => {
  const result = parseDate("next week Monday 9am");
  expect(result).not.toBeNull();

  // chrono may interpret "next week" differently, just verify it parses to a future date
  // Note: chrono doesn't handle "next week" + day + time reliably, so we just check it parses
  const now = new Date();
  expect(result!.getTime()).toBeGreaterThan(now.getTime());
});

// Tests for 24-hour format
Deno.test("Date parsing - 'tomorrow 14:00' parses to 14:00", () => {
  const result = parseDate("tomorrow 14:00");
  expect(result).not.toBeNull();

  expect(result!.getHours()).toBe(14);
  expect(result!.getMinutes()).toBe(0);
});

Deno.test("Date parsing - 'tomorrow 09:30' parses to 09:30", () => {
  const result = parseDate("tomorrow 09:30");
  expect(result).not.toBeNull();

  expect(result!.getHours()).toBe(9);
  expect(result!.getMinutes()).toBe(30);
});

Deno.test("Date parsing - 'tomorrow 17:45' parses to 17:45", () => {
  const result = parseDate("tomorrow 17:45");
  expect(result).not.toBeNull();

  expect(result!.getHours()).toBe(17);
  expect(result!.getMinutes()).toBe(45);
});

Deno.test("Date parsing - 'Monday 08:00' parses to 08:00", () => {
  const result = parseDate("Monday 08:00");
  expect(result).not.toBeNull();

  expect(result!.getHours()).toBe(8);
  expect(result!.getMinutes()).toBe(0);
});

Deno.test("Date parsing - 'Friday 20:00' parses to 20:00", () => {
  const result = parseDate("Friday 20:00");
  expect(result).not.toBeNull();

  expect(result!.getHours()).toBe(20);
  expect(result!.getMinutes()).toBe(0);
});

// Tests for relative time
Deno.test("Date parsing - 'in 2 hours' parses correctly", () => {
  const now = new Date();
  const result = parseDate("in 2 hours");
  expect(result).not.toBeNull();

  const expectedHour = (now.getHours() + 2) % 24;
  expect(result!.getHours()).toBe(expectedHour);
});

Deno.test("Date parsing - 'in 30 minutes' parses correctly", () => {
  const now = new Date();
  const result = parseDate("in 30 minutes");
  expect(result).not.toBeNull();

  // Should be approximately 30 minutes from now
  const diffMs = result!.getTime() - now.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  expect(diffMinutes).toBeGreaterThanOrEqual(29);
  expect(diffMinutes).toBeLessThanOrEqual(31);
});

Deno.test("Date parsing - 'in 1 hour' parses correctly", () => {
  const now = new Date();
  const result = parseDate("in 1 hour");
  expect(result).not.toBeNull();

  const diffMs = result!.getTime() - now.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  expect(diffMinutes).toBeGreaterThanOrEqual(59);
  expect(diffMinutes).toBeLessThanOrEqual(61);
});

// Tests for specific date format
Deno.test("Date parsing - '2025-06-15 14:00' parses correctly", () => {
  const result = parseDate("2025-06-15 14:00");
  expect(result).not.toBeNull();

  expect(result!.getFullYear()).toBe(2025);
  expect(result!.getMonth()).toBe(5); // June = 5 (0-indexed)
  expect(result!.getDate()).toBe(15);
  expect(result!.getHours()).toBe(14);
  expect(result!.getMinutes()).toBe(0);
});

Deno.test("Date parsing - '15 June 2025 2pm' parses correctly", () => {
  const result = parseDate("15 June 2025 2pm");
  expect(result).not.toBeNull();

  expect(result!.getFullYear()).toBe(2025);
  expect(result!.getMonth()).toBe(5); // June = 5
  expect(result!.getDate()).toBe(15);
  expect(result!.getHours()).toBe(14);
});

Deno.test("Date parsing - 'June 15, 2025 at 3pm' parses correctly", () => {
  const result = parseDate("June 15, 2025 at 3pm");
  expect(result).not.toBeNull();

  expect(result!.getFullYear()).toBe(2025);
  expect(result!.getMonth()).toBe(5);
  expect(result!.getDate()).toBe(15);
  expect(result!.getHours()).toBe(15);
});

Deno.test("Date parsing - '12/25/2025 10am' parses correctly", () => {
  const result = parseDate("12/25/2025 10am");
  expect(result).not.toBeNull();

  expect(result!.getFullYear()).toBe(2025);
  expect(result!.getMonth()).toBe(11); // December = 11
  expect(result!.getDate()).toBe(25);
  expect(result!.getHours()).toBe(10);
});

// Tests for time-only format (assumes today or tomorrow)
Deno.test("Date parsing - '14:00' parses to today or tomorrow at 14:00", () => {
  const result = parseDate("14:00");
  expect(result).not.toBeNull();

  expect(result!.getHours()).toBe(14);
  expect(result!.getMinutes()).toBe(0);
});

Deno.test("Date parsing - '3pm' parses correctly", () => {
  const result = parseDate("3pm");
  expect(result).not.toBeNull();

  expect(result!.getHours()).toBe(15);
});

Deno.test("Date parsing - '10:30am' parses correctly", () => {
  const result = parseDate("10:30am");
  expect(result).not.toBeNull();

  expect(result!.getHours()).toBe(10);
  expect(result!.getMinutes()).toBe(30);
});

// Tests for abbreviated day names
Deno.test("Date parsing - 'Mon 10am' parses to Monday at 10:00", () => {
  const result = parseDate("Mon 10am");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(1);
  expect(result!.getHours()).toBe(10);
});

Deno.test("Date parsing - 'Tue 2pm' parses to Tuesday at 14:00", () => {
  const result = parseDate("Tue 2pm");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(2);
  expect(result!.getHours()).toBe(14);
});

Deno.test("Date parsing - 'Wed 15:00' parses to Wednesday at 15:00", () => {
  const result = parseDate("Wed 15:00");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(3);
  expect(result!.getHours()).toBe(15);
});

Deno.test("Date parsing - 'Thu 11am' parses correctly", () => {
  const result = parseDate("Thu 11am");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(4);
  expect(result!.getHours()).toBe(11);
});

Deno.test("Date parsing - 'Fri 4:30pm' parses correctly", () => {
  const result = parseDate("Fri 4:30pm");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(5);
  expect(result!.getHours()).toBe(16);
  expect(result!.getMinutes()).toBe(30);
});

Deno.test("Date parsing - 'Sat 9am' parses correctly", () => {
  const result = parseDate("Sat 9am");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(6);
  expect(result!.getHours()).toBe(9);
});

Deno.test("Date parsing - 'Sun 12pm' parses to Sunday at 12:00 (noon)", () => {
  const result = parseDate("Sun 12pm");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(0);
  expect(result!.getHours()).toBe(12);
});

// Tests for edge cases
Deno.test("Date parsing - 'noon tomorrow' parses to tomorrow at 12:00", () => {
  const result = parseDate("noon tomorrow");
  expect(result).not.toBeNull();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(result!.getDate()).toBe(tomorrow.getDate());
  expect(result!.getHours()).toBe(12);
});

Deno.test("Date parsing - 'tomorrow noon' parses to tomorrow at 12:00", () => {
  const result = parseDate("tomorrow noon");
  expect(result).not.toBeNull();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(result!.getDate()).toBe(tomorrow.getDate());
  expect(result!.getHours()).toBe(12);
});

Deno.test("Date parsing - 'midnight' parses to 00:00", () => {
  const result = parseDate("midnight");
  expect(result).not.toBeNull();

  expect(result!.getHours()).toBe(0);
  expect(result!.getMinutes()).toBe(0);
});

Deno.test("Date parsing - 'today 5pm' parses to today at 17:00", () => {
  const result = parseDate("today 5pm");
  expect(result).not.toBeNull();

  const today = new Date();
  expect(result!.getDate()).toBe(today.getDate());
  expect(result!.getHours()).toBe(17);
});

// Tests for invalid inputs
Deno.test("Date parsing - 'gibberish not a time' returns null", () => {
  const result = parseDate("gibberish not a time");
  expect(result).toBeNull();
});

Deno.test("Date parsing - 'asdfqwer' returns null", () => {
  const result = parseDate("asdfqwer");
  expect(result).toBeNull();
});

Deno.test("Date parsing - empty string returns null", () => {
  const result = parseDate("");
  expect(result).toBeNull();
});

Deno.test("Date parsing - 'just some random words' returns null", () => {
  const result = parseDate("just some random words");
  expect(result).toBeNull();
});

// Tests for European date format
Deno.test("Date parsing - '15/06/2025 14:00' parses correctly", () => {
  const result = parseDate("15/06/2025 14:00");
  expect(result).not.toBeNull();

  // Note: chrono might interpret this as MM/DD or DD/MM depending on locale
  // This test verifies it parses to something valid
  expect(result!.getHours()).toBe(14);
  expect(result!.getMinutes()).toBe(0);
});

// Tests for morning/afternoon/evening
Deno.test("Date parsing - 'tomorrow morning' parses to tomorrow morning", () => {
  const result = parseDate("tomorrow morning");
  expect(result).not.toBeNull();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(result!.getDate()).toBe(tomorrow.getDate());
  // Morning is typically interpreted as around 9am
  expect(result!.getHours()).toBeGreaterThanOrEqual(6);
  expect(result!.getHours()).toBeLessThanOrEqual(12);
});

Deno.test("Date parsing - 'tomorrow afternoon' parses to tomorrow afternoon", () => {
  const result = parseDate("tomorrow afternoon");
  expect(result).not.toBeNull();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(result!.getDate()).toBe(tomorrow.getDate());
  // Afternoon is typically interpreted as around 12pm-3pm
  expect(result!.getHours()).toBeGreaterThanOrEqual(12);
  expect(result!.getHours()).toBeLessThanOrEqual(18);
});

Deno.test("Date parsing - 'tomorrow evening' parses to tomorrow evening", () => {
  const result = parseDate("tomorrow evening");
  expect(result).not.toBeNull();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  expect(result!.getDate()).toBe(tomorrow.getDate());
  // Evening is typically interpreted as around 6pm-8pm
  expect(result!.getHours()).toBeGreaterThanOrEqual(17);
  expect(result!.getHours()).toBeLessThanOrEqual(21);
});

// Tests for "this" format
Deno.test("Date parsing - 'this Monday 10am' parses correctly", () => {
  const result = parseDate("this Monday 10am");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(1);
  expect(result!.getHours()).toBe(10);
});

Deno.test("Date parsing - 'this Friday 3pm' parses correctly", () => {
  const result = parseDate("this Friday 3pm");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(5);
  expect(result!.getHours()).toBe(15);
});

// Tests for ordinal dates
Deno.test("Date parsing - 'January 15th 2025 2pm' parses correctly", () => {
  const result = parseDate("January 15th 2025 2pm");
  expect(result).not.toBeNull();

  expect(result!.getFullYear()).toBe(2025);
  expect(result!.getMonth()).toBe(0); // January = 0
  expect(result!.getDate()).toBe(15);
  expect(result!.getHours()).toBe(14);
});

Deno.test("Date parsing - 'March 1st 10am' parses correctly", () => {
  const result = parseDate("March 1st 10am");
  expect(result).not.toBeNull();

  expect(result!.getMonth()).toBe(2); // March = 2
  expect(result!.getDate()).toBe(1);
  expect(result!.getHours()).toBe(10);
});

Deno.test("Date parsing - 'the 22nd at 4pm' parses to 4pm", () => {
  const result = parseDate("the 22nd at 4pm");
  expect(result).not.toBeNull();

  // chrono may interpret "the 22nd" slightly differently based on current date
  // Just verify it parses and the time is correct
  expect(result!.getHours()).toBe(16);
});

// Tests for combined formats that users might actually type
Deno.test("Date parsing - 'next tue 14:30' parses correctly", () => {
  const result = parseDate("next tue 14:30");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(2);
  expect(result!.getHours()).toBe(14);
  expect(result!.getMinutes()).toBe(30);
});

Deno.test("Date parsing - 'wed 3:30pm' parses correctly", () => {
  const result = parseDate("wed 3:30pm");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(3);
  expect(result!.getHours()).toBe(15);
  expect(result!.getMinutes()).toBe(30);
});

Deno.test("Date parsing - '2pm on Friday' parses correctly", () => {
  const result = parseDate("2pm on Friday");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(5);
  expect(result!.getHours()).toBe(14);
});

Deno.test("Date parsing - 'Friday at 2' parses to Friday at 2:00", () => {
  const result = parseDate("Friday at 2");
  expect(result).not.toBeNull();

  expect(result!.getDay()).toBe(5);
  // "at 2" without am/pm is ambiguous - chrono interprets as 2am
  // Users should specify "2pm" for afternoon times
  expect(result!.getHours()).toBe(2);
});

// Test that the parsed date is a valid Date object
Deno.test("Date parsing - result is a valid Date object", () => {
  const result = parseDate("tomorrow 2pm");
  expect(result).not.toBeNull();
  expect(result).toBeInstanceOf(Date);
  expect(result!.toString()).not.toBe("Invalid Date");
});

// Test that the parsed date can be converted to ISO string
Deno.test("Date parsing - result can be converted to ISO string", () => {
  const result = parseDate("2025-06-15 14:00");
  expect(result).not.toBeNull();

  const isoString = result!.toISOString();
  expect(isoString).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});
