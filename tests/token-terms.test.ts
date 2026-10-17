/** Paying with tokens is not the same service as paying in euros: the fine print, verbatim from the website. */
import { expect } from "@std/expect/expect";
import { calendarTermsLine, isEuroToken, ROOM_TOKEN_TERMS, roomFinePrint, roomTermsFor } from "../src/lib/token-terms.ts";

Deno.test("room terms for tokens, nothing for euro tokens", () => {
  expect(ROOM_TOKEN_TERMS).toBe("Rooms booked with tokens: only when capacity is idle, subject to community activities, without cleaning or stewarding.");
  for (const eur of ["EURb", "EURe", "EURchb", "eurb"]) {
    expect(isEuroToken(eur)).toBe(true);
    expect(roomTermsFor(eur)).toBeUndefined();
    expect(roomFinePrint(eur)).toBe("");
    expect(calendarTermsLine(eur)).toBe("");
  }
  expect(roomTermsFor("CHT")).toBe(ROOM_TOKEN_TERMS);
  expect(roomFinePrint("CHT")).toBe(`\n-# ${ROOM_TOKEN_TERMS}`);
  expect(calendarTermsLine("CHT")).toBe(`\n${ROOM_TOKEN_TERMS}`);
});
