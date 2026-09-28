import { expect } from "@std/expect/expect";
import { findConflict, MAX_BOOKING_DATES, occurrencesFor, parseDateList } from "../src/lib/book-dates.ts";

const today = new Date(2026, 8, 28); // 28 Sep 2026
const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

Deno.test("a single date works as before", () => {
  const { dates, errors } = parseDateList("15/10/2026", today);
  expect(errors).toEqual([]);
  expect(dates.map(ymd)).toEqual(["2026-10-15"]);
});

Deno.test("comma separated dates are sorted and deduplicated, with any separator style", () => {
  const { dates, errors } = parseDateList("22/10/2026, 15-10-2026 ;15.10.2026,  29/10/26", today);
  expect(errors).toEqual([]);
  expect(dates.map(ymd)).toEqual(["2026-10-15", "2026-10-22", "2026-10-29"]);
});

Deno.test("a date without year is the next such day", () => {
  expect(parseDateList("15/10", today).dates.map(ymd)).toEqual(["2026-10-15"]);
  expect(parseDateList("15/01", today).dates.map(ymd)).toEqual(["2027-1-15"]);
});

Deno.test("invalid, impossible and past dates are reported one by one", () => {
  const { dates, errors } = parseDateList("31/02/2027, tomorrow, 01/09/2026, 20/10/2026", today);
  expect(dates.map(ymd)).toEqual(["2026-10-20"]);
  expect(errors).toHaveLength(3);
  expect(errors.join(" ")).toContain("does not exist");
  expect(errors.join(" ")).toContain("not a date");
  expect(errors.join(" ")).toContain("in the past");
});

Deno.test("too many dates is an error", () => {
  const many = Array.from({ length: MAX_BOOKING_DATES + 1 }, (_, i) => `${i + 1}/11/2026`).join(",");
  const { errors } = parseDateList(many, today);
  expect(errors[0]).toContain(`at most ${MAX_BOOKING_DATES}`);
});

Deno.test("occurrences use the same time and duration on each date; conflicts are overlaps only", () => {
  const occ = occurrencesFor([new Date(2026, 9, 15), new Date(2026, 9, 22)], 14, 30, 90);
  expect(occ.map((o) => [o.start.getHours(), o.start.getMinutes(), o.end.getHours(), o.end.getMinutes()])).toEqual([[14, 30, 16, 0], [14, 30, 16, 0]]);
  const at = (h: number, m: number) => new Date(2026, 9, 15, h, m).toISOString();
  const touching = { start: { dateTime: at(16, 0) }, end: { dateTime: at(17, 0) }, summary: "after" };
  const overlapping = { start: { dateTime: at(13, 0) }, end: { dateTime: at(14, 45) }, summary: "clash" };
  expect(findConflict(occ[0], [touching])).toBeUndefined();
  expect(findConflict(occ[0], [touching, overlapping])?.summary).toBe("clash");
  expect(findConflict(occ[1], [overlapping])).toBeUndefined();
});
