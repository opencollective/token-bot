import { expect } from "@std/expect/expect";
import { buildBookingEmail, buildIcs, FALLBACK_COSTS, fetchRoomImage } from "../src/lib/booking-email.ts";
import { findGuestBooking, notifyGuestBookingCancelled, notifyGuestBookingChanged, recordGuestBooking } from "../src/lib/guest-bookings.ts";

const base = {
  guestName: "Ana", guestEmail: "ana@example.com", bookerName: "Xavier", bookerEmail: "x@example.com",
  eventName: "Planning", roomName: "Mush Room", priceTotal: 2, tokenSymbol: "CHT", bookingId: "b",
  occurrences: [{ start: new Date("2026-10-15T15:00:00Z"), end: new Date("2026-10-15T17:00:00Z") }],
};

Deno.test("confirmation shows the room photo and asks to contact the booker", () => {
  const { html, text } = buildBookingEmail({ ...base, roomImageUrl: "https://commonshub.brussels/api/image-proxy?url=%2Fimages%2Fmush-room.jpg&size=md" }, FALLBACK_COSTS);
  expect(html).toContain('<img src="https://commonshub.brussels/api/image-proxy?url=%2Fimages%2Fmush-room.jpg&amp;size=md" alt="Mush Room"');
  expect(text).toContain("please contact Xavier (x@example.com), who booked it for you and is in cc");
  expect(html).toContain("Questions about this booking? Contact Xavier (x@example.com), in cc");
});

Deno.test("a change says so, shows what it was before, keeps the door and community sections", () => {
  const { subject, html, text } = buildBookingEmail({
    ...base, kind: "updated", roomName: "Angel Room",
    previous: { roomName: "Mush Room", occurrences: base.occurrences },
    doorLinks: ["https://door.commonshub.brussels/open?x"],
  }, FALLBACK_COSTS);
  expect(subject).toContain("was changed: Angel Room");
  expect(text).toContain("your booking was changed");
  expect(text).toContain("Before: Mush Room, Thursday, 15 October 2026, 17:00–19:00.");
  expect(html).toContain("Open the door");
  expect(html).toContain("Contribute</a>");
});

Deno.test("a cancellation is short: no photo, no door, no community sections", () => {
  const { subject, html, text } = buildBookingEmail({ ...base, kind: "cancelled", roomImageUrl: "https://x/img", doorLinks: ["https://door/x"] }, FALLBACK_COSTS);
  expect(subject).toContain("was cancelled: Mush Room");
  expect(text).toContain("The room is no longer reserved for you at this time.");
  expect(text).toContain("removes the booking from your calendar");
  for (const absent of ["https://x/img", "Open the door", "Paid with time", "Become a member", "Contribute</a>"]) expect(html).not.toContain(absent);
});

Deno.test("ics updates and cancellations keep the uid and bump the sequence", () => {
  const e = { uid: "evt1@commonshub.brussels", start: base.occurrences[0].start, end: base.occurrences[0].end, summary: "S", description: "D", location: "L" };
  const updated = buildIcs([{ ...e, sequence: 1 }]);
  expect(updated).toContain("METHOD:PUBLISH");
  expect(updated).toContain("UID:evt1@commonshub.brussels\r\nSEQUENCE:1");
  const cancelled = buildIcs([{ ...e, sequence: 2, cancelled: true }]);
  expect(cancelled).toContain("METHOD:CANCEL");
  expect(cancelled).toContain("SEQUENCE:2\r\nSTATUS:CANCELLED");
});

Deno.test("room photo: the cover shown on the room's page, or the known one", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (() => Promise.resolve(new Response(`<img alt="x" src="/api/image-proxy?url=%2Fimages%2Fnew-cover.jpg&amp;size=lg">`))) as typeof fetch;
    expect(await fetchRoomImage("mushroom")).toBe("https://commonshub.brussels/api/image-proxy?url=%2Fimages%2Fnew-cover.jpg&size=md");
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    expect(await fetchRoomImage("angelroom")).toBe("https://commonshub.brussels/api/image-proxy?url=%2Fimages%2Fangel-room.jpeg&size=md");
    expect(await fetchRoomImage("unknown")).toBeUndefined();
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("a guest booking is remembered, then the guest is emailed when it changes and when it is cancelled", async () => {
  Deno.env.set("DATA_DIR", "./cache/test-data");
  Deno.env.set("RESEND_API_KEY", "re_test");
  Deno.env.delete("DOOR_SIGNING_KEY");
  await Deno.remove("./cache/test-data/g2", { recursive: true }).catch(() => {});
  const sent: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://api.resend.com")) {
      sent.push(JSON.parse(String(init!.body)));
      return Promise.resolve(new Response(JSON.stringify({ id: "r" + sent.length })));
    }
    return Promise.reject(new Error("offline")); // website lookups fall back
  }) as typeof fetch;
  try {
    await recordGuestBooking("g2", {
      calendarId: "calA", eventId: "e1", uid: "e1@commonshub.brussels", sequence: 0, productSlug: "mushroom", roomName: "Mush Room",
      guestName: "Ana", guestEmail: "ana@example.com", bookerId: "u1", bookerName: "Xavier", bookerEmail: "x@example.com",
      eventName: "Planning", start: "2026-10-15T15:00:00.000Z", end: "2026-10-15T17:00:00.000Z", tokenSymbol: "CHT", priceTotal: 2, status: "active",
    });
    expect(await notifyGuestBookingChanged("g2", "nope", "e1", { calendarId: "x", eventId: "x", productSlug: "x", roomName: "x", start: new Date(), end: new Date(), priceTotal: 0 })).toBe("");

    const changed = await notifyGuestBookingChanged("g2", "calA", "e1", {
      calendarId: "calB", eventId: "e2", productSlug: "angelroom", roomName: "Angel Room",
      start: new Date("2026-10-16T08:00:00Z"), end: new Date("2026-10-16T10:00:00Z"), priceTotal: 2,
    });
    expect(changed).toContain("Ana was emailed the new details (you are in cc)");
    expect(sent[0].to).toEqual(["ana@example.com"]);
    expect(sent[0].cc).toEqual(["x@example.com"]);
    expect(sent[0].reply_to).toEqual(["x@example.com"]);
    expect(sent[0].subject).toContain("was changed: Angel Room");
    const ics1 = new TextDecoder().decode(Uint8Array.from(atob(sent[0].attachments[0].content), (c) => c.charCodeAt(0)));
    expect(ics1).toContain("UID:e1@commonshub.brussels\r\nSEQUENCE:1");
    expect(await findGuestBooking("g2", "calA", "e1")).toBeUndefined();
    expect((await findGuestBooking("g2", "calB", "e2"))?.roomName).toBe("Angel Room");

    const cancelled = await notifyGuestBookingCancelled("g2", "calB", "e2");
    expect(cancelled).toContain("emailed that the booking is cancelled");
    expect(sent[1].subject).toContain("was cancelled: Angel Room");
    expect(sent[1].attachments[0].content_type).toContain("method=CANCEL");
    const ics2 = new TextDecoder().decode(Uint8Array.from(atob(sent[1].attachments[0].content), (c) => c.charCodeAt(0)));
    expect(ics2).toContain("UID:e1@commonshub.brussels\r\nSEQUENCE:2\r\nSTATUS:CANCELLED");
    expect(await findGuestBooking("g2", "calB", "e2")).toBeUndefined();
    expect(await notifyGuestBookingCancelled("g2", "calB", "e2")).toBe(""); // only once
  } finally {
    globalThis.fetch = real;
    Deno.env.delete("RESEND_API_KEY");
  }
});

import { hourlyRates, paidLine, ratesFromPrices, roomLine, sendBookingConfirmation } from "../src/lib/booking-email.ts";

Deno.test("under the photo: room name, capacity and hourly prices in euros (+ VAT) and tokens", () => {
  const rates = ratesFromPrices([{ token: "CHT", amount: 1 }, { token: "EURb", amount: 40 }], 10);
  expect(rates).toEqual({ eurPerHour: 40, tokensPerHour: 1, tokenSymbol: "CHT", capacity: 10 });
  expect(roomLine("Mush Room", rates)).toBe("Mush Room · up to 10 people · €40/h + VAT or 1 token/h");
  expect(roomLine("Phone booth", ratesFromPrices([{ token: "CHT", amount: 0.5 }, { token: "EURb", amount: 10 }], 1))).toBe("Phone booth · up to 1 person · €10/h + VAT or 0.5 token/h");
  expect(roomLine("Room", undefined)).toBe("Room");
  expect(roomLine("Satoshi Room", ratesFromPrices([{ token: "CHT", amount: 2 }, { token: "EURb", amount: 60 }], 15))).toBe("Satoshi Room · up to 15 people · €60/h + VAT or 2 tokens/h");
  expect(hourlyRates(ratesFromPrices([{ token: "CHT", amount: 3 }, { token: "EURb", amount: 130 }]))).toBe("€130/h + VAT or 3 tokens/h");
  expect(hourlyRates(ratesFromPrices([{ token: "CHT", amount: 2 }]))).toBe("2 tokens/h");

  const withRates = { ...base, roomImageUrl: "https://x/img.jpg", rates };
  const confirmed = buildBookingEmail(withRates, FALLBACK_COSTS);
  expect(confirmed.html).toContain(">Mush Room · up to 10 people · €40/h + VAT or 1 token/h</p>");
  expect(confirmed.html.indexOf("https://x/img.jpg")).toBeLessThan(confirmed.html.indexOf("up to 10 people"));
  expect(confirmed.text).toContain("Room: Mush Room · up to 10 people · €40/h + VAT or 1 token/h");
  for (const t of [confirmed.html, confirmed.text]) expect(t.toLowerCase()).not.toContain("usual rate");
  expect(buildBookingEmail({ ...withRates, kind: "updated" }, FALLBACK_COSTS).html).toContain("up to 10 people");
  const cancelled = buildBookingEmail({ ...withRates, kind: "cancelled" }, FALLBACK_COSTS);
  expect(cancelled.html).not.toContain("up to 10 people");
  expect(cancelled.text).toContain("Room: Mush Room\n");
});

Deno.test("what was paid: tokens as is, euros excl. VAT", () => {
  expect(paidLine(2, "CHT")).toBe("2 CHT");
  expect(paidLine(260, "EURb")).toBe("€260 (paid in EURb, excl. VAT)");
  const cht = buildBookingEmail(base, FALLBACK_COSTS);
  expect(cht.text).toContain("Paid: 2 CHT");
  expect(cht.text).toContain("PAID WITH TIME, NOT MONEY");
  const eur = buildBookingEmail({ ...base, priceTotal: 80, tokenSymbol: "EURb", txUrl: "https://tx" }, FALLBACK_COSTS);
  expect(eur.text).toContain("Paid: €80 (paid in EURb, excl. VAT)");
  expect(eur.html).toContain("<strong>Paid:</strong> €80 (paid in EURb, excl. VAT)");
  for (const t of [eur.html, eur.text]) expect(t.toLowerCase()).not.toContain("paid with time");
  expect(eur.text).toContain("Transaction: https://tx");
  expect(buildBookingEmail({ ...base, kind: "cancelled" }, FALLBACK_COSTS).text).not.toContain("Paid:");
});

Deno.test("booking for yourself: your own record, no 'booked for you', no cc", async () => {
  const self = {
    ...base, guestName: "Xavier", guestEmail: "x@example.com", bookerName: "Xavier", bookerEmail: undefined,
    forSelf: true, doorLinks: ["https://door.commonshub.brussels/open?x"],
    rates: ratesFromPrices([{ token: "CHT", amount: 1 }, { token: "EURb", amount: 40 }], 10),
  };
  const { subject, html, text } = buildBookingEmail(self, FALLBACK_COSTS);
  expect(subject).toBe("Your booking at the Commons Hub: Mush Room, 15 Oct");
  expect(text).toContain("Hi Xavier, your room is booked");
  expect(text).toContain("You booked the Mush Room at the Commons Hub Brussels. Here are the details, for your records.");
  expect(text).toContain("When: Thursday, 15 October 2026, 17:00–19:00");
  expect(text).toContain("Paid: 2 CHT");
  expect(text).toContain("Open the door: https://door.commonshub.brussels/open?x");
  expect(text).toContain("ring the bell or reply to this email");
  expect(text).toContain("because you gave time to the community");
  expect(html).toContain("Questions about this booking? Reply to this email.");
  for (const t of [html, text]) {
    expect(t).not.toContain("booked it for you");
    expect(t).not.toContain("at the Commons Hub Brussels for you");
    expect(t).not.toContain("Booked by:");
    expect(t).not.toContain("in cc");
  }

  // Sent to the booker only, with the .ics attached
  const sent: any[] = [];
  const real = globalThis.fetch;
  Deno.env.set("RESEND_API_KEY", "test");
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(JSON.stringify({ id: "m1" }), { status: 200 }));
    }
    return Promise.resolve(new Response("", { status: 404 }));
  }) as typeof fetch;
  try {
    await sendBookingConfirmation(self);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toEqual(["x@example.com"]);
    expect(sent[0].cc).toBeUndefined();
    expect(sent[0].attachments[0].filename).toBe("commonshub-booking.ics");
    expect(sent[0].attachments[0].content_type).toContain("method=PUBLISH");
  } finally {
    globalThis.fetch = real;
    Deno.env.delete("RESEND_API_KEY");
  }
});
