import { expect } from "@std/expect/expect";
import { verifyMessage, Wallet } from "ethers";
import { bookingReason, buildDoorLink, DOOR_URL, timeRange } from "../src/lib/door-link.ts";
import { buildBookingEmail, FALLBACK_COSTS } from "../src/lib/booking-email.ts";

/** What the door server does with req.query (server/index.js verifyEventOrganizerSignature). */
function doorVerify(url: string): string {
  const q = Object.fromEntries(new URL(url).searchParams);
  let message = `name=${q.name}&host=${q.host}&reason=${q.reason}&timestamp=${q.timestamp}&startTime=${q.startTime}&duration=${q.duration}`;
  if (q.eventUrl) message += `&eventUrl=${q.eventUrl}`;
  if (q.booking === "1") message += "&booking=1";
  return verifyMessage(message, q.sig);
}

Deno.test("door links verify like the door server does and carry the booking window", async () => {
  const w = Wallet.createRandom();
  const start = new Date("2026-10-15T08:00:00Z"), end = new Date("2026-10-15T10:30:00Z");
  const url = (await buildDoorLink({ name: "Ana (guest)", host: "Xavier Damman", reason: "Planning: Q4 & beyond", start, end, eventUrl: "https://lu.ma/abc" }, w.privateKey))!;
  expect(url.startsWith(`${DOOR_URL}/open?`)).toBe(true);
  expect(doorVerify(url)).toBe(w.address);
  const q = new URL(url).searchParams;
  expect(q.get("startTime")).toBe(String(start.getTime() / 1000));
  expect(q.get("duration")).toBe("150");
  expect(q.get("reason")).toBe("Planning: Q4 beyond"); // "&" removed so the signed string stays unambiguous
  expect(q.get("name")).toBe("Ana (guest)");
});

Deno.test("no key, no link; links without an event url still verify", async () => {
  expect(await buildDoorLink({ name: "A", host: "B", reason: "C", start: new Date(), end: new Date(Date.now() + 3600e3) }, undefined)).toBeNull();
  const w = Wallet.createRandom();
  const url = (await buildDoorLink({ name: "A", host: "B", reason: "C", start: new Date(), end: new Date(Date.now() + 3600e3), eventUrl: "not a url" }, w.privateKey))!;
  expect(new URL(url).searchParams.has("eventUrl")).toBe(false);
  expect(doorVerify(url)).toBe(w.address);
});

Deno.test("the email shows a door button per date with the validity window", () => {
  const occurrences = [
    { start: new Date("2026-10-15T08:00:00Z"), end: new Date("2026-10-15T10:00:00Z") },
    { start: new Date("2026-10-22T08:00:00Z"), end: new Date("2026-10-22T10:00:00Z") },
  ];
  const base = { guestName: "Ana", guestEmail: "a@example.com", bookerName: "Xavier", eventName: "Planning", roomName: "Mush Room", priceTotal: 4, tokenSymbol: "CHT", bookingId: "t", occurrences };
  const one = buildBookingEmail({ ...base, occurrences: occurrences.slice(0, 1), doorLinks: ["https://door.commonshub.brussels/open?x=1"] }, FALLBACK_COSTS);
  expect(one.html).toContain("🚪 Open the door</a>");
  expect(one.html).toContain("background:#ffffff;color:#001309;border:2px solid #001309");
  expect(one.text).toContain("(09:30–12:30)"); // 10:00–12:00 Brussels, ±30 min
  expect(one.text).toContain("#door channel");
  const two = buildBookingEmail({ ...base, doorLinks: ["https://door/1", "https://door/2"] }, FALLBACK_COSTS);
  expect(two.html).toContain("Open the door · Thu 15 Oct");
  expect(two.html).toContain("Open the door · Thu 22 Oct");
  const none = buildBookingEmail({ ...base, doorLinks: [null, null] }, FALLBACK_COSTS);
  expect(none.html).not.toContain("Getting in");
});

Deno.test("booking links are marked booking=1 and read '<room> booking today from 5-7pm'", async () => {
  const w = Wallet.createRandom();
  const start = new Date("2026-10-15T15:00:00Z"), end = new Date("2026-10-15T17:00:00Z"); // 5-7pm in Brussels
  const reason = bookingReason("Mush Room", start, end);
  expect(reason).toBe("Mush Room booking today from 5-7pm");
  const url = (await buildDoorLink({ name: "Ana", host: "Xavier", reason, start, end }, w.privateKey))!;
  const q = new URL(url).searchParams;
  expect(q.get("booking")).toBe("1");
  expect(q.get("name")).toBe("Ana");
  expect(doorVerify(url)).toBe(w.address);
});

Deno.test("time ranges read naturally", () => {
  const at = (iso: string) => new Date(iso);
  expect(timeRange(at("2026-10-15T07:30:00Z"), at("2026-10-15T10:00:00Z"))).toBe("9:30am-12pm");
  expect(timeRange(at("2026-10-15T09:00:00Z"), at("2026-10-15T11:00:00Z"))).toBe("11am-1pm");
  expect(timeRange(at("2026-12-15T16:00:00Z"), at("2026-12-15T18:30:00Z"))).toBe("5-7:30pm"); // winter time, UTC+1
});
