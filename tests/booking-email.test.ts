import { expect } from "@std/expect/expect";
import { buildBookingEmail, buildIcs, eurRounded, FALLBACK_COSTS, HUB, parseCosts } from "../src/lib/booking-email.ts";

Deno.test("costs are read from the contribute page's cost bar, with the website's colors", () => {
  const html = `<div role="img"><a title="Rent: €6,546.76 a month, 67%" class="x" style="flex-grow:6546.76;background-color:var(--cost-1)" href="/expenses/rent"></a>` +
    `<a title="Internet (Proximus): €54.45 a month, 0.6%" style="background-color:var(--cost-6)" href="/expenses/internet"></a></div>`;
  const c = parseCosts(html)!;
  expect(c.lines).toEqual([
    { label: "Rent", amountEur: 6546.76, color: "#2a78d6" },
    { label: "Internet (Proximus)", amountEur: 54.45, color: "#008300" },
  ]);
  expect(c.totalEur).toBeCloseTo(6601.21);
  expect(parseCosts("<div>nothing</div>")).toBeNull();
  expect(eurRounded(9820.23)).toBe("€9,820");
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
  expect(html).toContain("in fixed costs, every month");
  expect(html).toContain("background:#2a78d6");
  expect(html).toContain(">Contribute</a>");
  expect(html).not.toContain("background:#FF4C02;color:#ffffff"); // buttons are white with an orange border
  expect(html).toContain("border:2px solid #FF4C02");
  expect(html).toContain('padding:8px 28px 32px'); // space between the last button and the footer line
  expect(text).toContain("- Rent: €6,547");
  for (const t of [text, html]) {
    expect(t).toContain("2 CHT");
    expect(t).toContain("as if it were their own house");
    expect(t).toContain("somebody else's house");
    expect(t).toContain(HUB.membershipUrl);
    expect(t).toContain("€9,820");
    expect(t).toContain("€6,547");
    expect(t).toContain("doing shifts");
    expect(t.replace(/width="[\d.]+%"/g, "")).not.toMatch(/\d%/); // no percentages shown; bar widths are layout
    expect(t).toContain("commonshub.brussels/contribute");
  }
});
