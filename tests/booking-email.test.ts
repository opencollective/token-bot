import { expect } from "@std/expect/expect";
import { buildBookingEmail, buildIcs, FALLBACK_COSTS, HUB, parseCostsLabel } from "../src/lib/booking-email.ts";

Deno.test("costs are read from the contribute page's fixed-costs label", () => {
  const html = `<div aria-label="Fixed costs, €9,820.23 a month: Rent 67%, Property tax (regional) 13%, Office tax (local) 11%, Furniture rental 6%, Electricity (Engie) 2%, Internet (Proximus) 0.6%"></div>`;
  const c = parseCostsLabel(html)!;
  expect(c.totalEur).toBe(9820.23);
  expect(c.lines.map((l) => l.label)).toEqual(["Rent", "Property tax (regional)", "Office tax (local)", "Furniture rental", "Electricity (Engie)", "Internet (Proximus)"]);
  expect(c.lines.at(-1)!.share).toBe(0.6);
  expect(parseCostsLabel("<div>nothing</div>")).toBeNull();
});

Deno.test("the ics is valid-looking: CRLF, UTC times, escaped text, folded long lines", () => {
  const ics = buildIcs([{
    uid: "tx1-0@commonshub.brussels",
    start: new Date("2026-10-15T12:30:00Z"),
    end: new Date("2026-10-15T14:00:00Z"),
    summary: "Workshop; drawing, painting",
    description: "Line one\nLine two " + "x".repeat(120),
    location: "Mush Room, Commons Hub Brussels, Rue de la Madeleine 51, 1000 Brussels",
  }], new Date("2026-10-02T08:00:00Z"));
  expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(ics).toContain("DTSTART:20261015T123000Z\r\n");
  expect(ics).toContain(String.raw`SUMMARY:Workshop\; drawing\, painting` + "\r\n");
  expect(ics).toContain("DESCRIPTION:Line one\\nLine two");
  for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
});

Deno.test("the email has the booking, CHT, house rule, membership and costs, and escapes names", () => {
  const { subject, html, text } = buildBookingEmail({
    guestName: "Ana <b>",
    guestEmail: "ana@example.com",
    bookerName: "Xavier",
    bookerEmail: "x@example.com",
    eventName: "Planning session",
    roomName: "Mush Room",
    occurrences: [{ start: new Date("2026-10-15T08:00:00Z"), end: new Date("2026-10-15T10:00:00Z") }],
    priceTotal: 2,
    tokenSymbol: "CHT",
    bookingId: "tx1",
  }, FALLBACK_COSTS);
  expect(subject).toContain("Mush Room, 15 Oct");
  expect(html).toContain("Ana &lt;b&gt;");
  expect(html).not.toContain("Ana <b>");
  expect(html).toContain(HUB.logoUrl);
  expect(html).toContain("Thursday, 15 October 2026, 10:00–12:00");
  for (const t of [text, html]) {
    expect(t).toContain("2 CHT");
    expect(t).toContain("as if it were their own house");
    expect(t).toContain("somebody else's house");
    expect(t).toContain(HUB.membershipUrl);
    expect(t).toContain("€9,820 a month");
    expect(t).toContain("Rent (67%)");
    expect(t).toContain("commonshub.brussels/contribute");
  }
});
