import { expect } from "@std/expect/expect";
import {
  bookingAnnotationContent,
  bookingAnnotationTags,
  calendarPaidLine,
  formatBookingDuration,
  paymentsFromEvents,
  txUri,
} from "../src/lib/booking-annotations.ts";
import { COMMUNITY_RELAY, configuredRelays } from "../src/lib/nostr.ts";

Deno.test("calendar Paid: line", () => {
  expect(calendarPaidLine(2, "CHT")).toBe("Paid: 2 CHT");
  expect(calendarPaidLine(1.5, "CHT")).toBe("Paid: 1.5 CHT");
  expect(calendarPaidLine(80, "EURb")).toBe("Paid: €80 (EURb)");
  expect(calendarPaidLine(32.5, "EURchb")).toBe("Paid: €32.5 (EURchb)");
  expect(calendarPaidLine(1 / 3, "CHT")).toBe("Paid: 0.33 CHT");
});

Deno.test("annotation content and tags match what chb merges", () => {
  expect(formatBookingDuration(60)).toBe("1h");
  expect(formatBookingDuration(90)).toBe("1h30");
  expect(formatBookingDuration(45)).toBe("45min");
  expect(bookingAnnotationContent("Mush Room", 60)).toBe("Booking Mush Room room for 1h");
  expect(bookingAnnotationContent("Angel Room", 90)).toBe("Booking Angel Room room for 1h30");
  expect(bookingAnnotationContent("Ostrom Room", 120, 3)).toBe("Booking Ostrom Room room for 3 × 2h");
  expect(bookingAnnotationTags("mushroom")).toEqual([["t", "booking"], ["t", "mushroom"], ["category", "rental"]]);
  expect(txUri("celo", "0xabc")).toBe("ethereum:42220:tx:0xabc");
  expect(() => txUri("mars", "0xabc")).toThrow("Unknown chain mars");
});

const TX1 = "0xfab8c02fe66ddc201402ced431bbb9d1b871fbd7892eca8730654ac9b5262e98";
const TX2 = "0xab3f1a17b678e46663718ff7f1c223f0bb0b22bddd8911b5a4440591467a0a2e";
const desc = (tx: string, extra = "") =>
  `Booked by Xavier (@xdamman) on Tuesday October 6th at 10:53am for 1.00 CHT\nPaid: 1 CHT${extra}\n\nUser ID: 1\nBooking TX: ${tx}\nBooking Chain: celo`;

Deno.test("payments are read from the room calendar, one per tx (multi-date grouped)", () => {
  const events = [
    { description: desc(TX1), start: { dateTime: "2026-10-06T09:00:00Z" }, end: { dateTime: "2026-10-06T10:00:00Z" } },
    { description: desc(TX2, ", date 1 of 2"), start: { dateTime: "2026-10-07T08:00:00Z" }, end: { dateTime: "2026-10-07T10:00:00Z" } },
    { description: desc(TX2, ", date 2 of 2"), start: { dateTime: "2026-10-14T08:00:00Z" }, end: { dateTime: "2026-10-14T10:00:00Z" } },
    { description: "Shift: no payment here", start: { dateTime: "2026-10-06T09:00:00Z" }, end: { dateTime: "2026-10-06T10:00:00Z" } },
    { description: desc(TX1).replace("Booking Chain: celo", ""), start: { dateTime: "2026-10-06T09:00:00Z" }, end: { dateTime: "2026-10-06T10:00:00Z" } },
  ];
  expect(paymentsFromEvents({ slug: "mushroom", name: "Mush Room" }, events)).toEqual([
    { txHash: TX1, chain: "celo", roomSlug: "mushroom", roomName: "Mush Room", durationMinutes: 60, dates: 1 },
    { txHash: TX2, chain: "celo", roomSlug: "mushroom", roomName: "Mush Room", durationMinutes: 120, dates: 2 },
  ]);
});

Deno.test("relays: the community relay first by default; NOSTR_RELAYS overrides", () => {
  const prev = Deno.env.get("NOSTR_RELAYS");
  try {
    Deno.env.delete("NOSTR_RELAYS");
    expect(configuredRelays()[0]).toBe(COMMUNITY_RELAY);
    expect(COMMUNITY_RELAY).toBe("wss://relay.commonshub.brussels");
    Deno.env.set("NOSTR_RELAYS", "wss://a.example, wss://b.example");
    expect(configuredRelays()).toEqual(["wss://a.example", "wss://b.example"]);
    Deno.env.set("NOSTR_RELAYS", " , ");
    expect(configuredRelays()[0]).toBe(COMMUNITY_RELAY);
  } finally {
    if (prev === undefined) Deno.env.delete("NOSTR_RELAYS");
    else Deno.env.set("NOSTR_RELAYS", prev);
  }
});
