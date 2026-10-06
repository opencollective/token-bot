import { expect } from "@std/expect/expect";
import {
  bookableFromMessage,
  checkBookableFrom,
  localHHMM,
  minutesOf,
  startTimeAllowed,
  timeLabel,
} from "../src/lib/room-rules.ts";

const coworking = { name: "Coworking", bookableFrom: "19:00" };
const mush: { name: string; bookableFrom?: string } = { name: "Mush Room", bookableFrom: undefined };

Deno.test("minutesOf and timeLabel", () => {
  expect(minutesOf("19:00")).toBe(1140);
  expect(minutesOf("7:05")).toBe(425);
  expect(minutesOf("25:00")).toBeNull();
  expect(minutesOf(undefined)).toBeNull();
  expect(timeLabel("19:00")).toBe("7pm");
  expect(timeLabel("19:30")).toBe("7:30pm");
  expect(timeLabel("09:00")).toBe("9am");
  expect(timeLabel("00:00")).toBe("12am");
  expect(timeLabel("12:00")).toBe("12pm");
});

Deno.test("coworking: only from 7pm; rooms without the field are unrestricted", () => {
  expect(bookableFromMessage(coworking)).toBe("The coworking space can only be booked from 7pm.");
  expect(startTimeAllowed(coworking, "18:30")).toBe(false);
  expect(startTimeAllowed(coworking, "19:00")).toBe(true);
  expect(startTimeAllowed(coworking, "21:30")).toBe(true);
  expect(startTimeAllowed(mush, "08:00")).toBe(true);
  expect(bookableFromMessage({ name: "Mush Room", bookableFrom: "10:00" })).toBe("The Mush Room can only be booked from 10am.");
});

Deno.test("checkBookableFrom uses the hub's timezone, not UTC", () => {
  // 17:30Z = 19:30 Brussels (summer time) → allowed; 16:30Z = 18:30 → refused.
  expect(localHHMM(new Date("2026-10-07T17:30:00Z"))).toBe("19:30");
  expect(checkBookableFrom(coworking, new Date("2026-10-07T17:30:00Z"))).toBeNull();
  expect(checkBookableFrom(coworking, new Date("2026-10-07T16:30:00Z"))).toBe("The coworking space can only be booked from 7pm.");
  // Winter time: 18:00Z = 19:00 Brussels → allowed.
  expect(checkBookableFrom(coworking, new Date("2026-12-07T18:00:00Z"))).toBeNull();
  expect(checkBookableFrom(mush, new Date("2026-10-07T06:00:00Z"))).toBeNull();
});

Deno.test("products.json: coworking is bookable from 19:00, like the website", async () => {
  const products = JSON.parse(await Deno.readTextFile("data/1280532848604086365/products.json"));
  const cw = products.find((p: { slug: string }) => p.slug === "coworking");
  expect(cw.bookableFrom).toBe("19:00");
  expect(products.filter((p: { bookableFrom?: string }) => p.bookableFrom).map((p: { slug: string }) => p.slug)).toEqual(["coworking"]);
});
