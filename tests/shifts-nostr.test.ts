import { expect } from "@std/expect/expect";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import {
  buildAttestation,
  buildProfile,
  buildRsvp,
  buildShiftOccurrence,
  deriveMemberSecretKey,
  parseAttestations,
  parseProfiles,
  parseRsvps,
  shiftCoordinate,
  shiftD,
} from "../src/lib/shifts-nostr.ts";

const community = { guildId: "1280532848604086365", name: "Commons Hub Brussels" };
const slot = { start: "08:30", end: "11:30" };
const later = { start: "11:30", end: "14:30" };
const slots = [slot, later];
const DAY = "2026-09-25";

Deno.test("shift coordinates match the website's convention", () => {
  const bot = "ab".repeat(32);
  expect(shiftD(community, DAY, slot)).toBe("shift-1280532848604086365-2026-09-25-0830");
  expect(shiftCoordinate(bot, community, DAY, slot)).toBe(`31923:${bot}:shift-1280532848604086365-2026-09-25-0830`);
  const occurrence = buildShiftOccurrence(community, bot, DAY, slot, 3, "Caretaking shift 08:30–11:30");
  const tag = (n: string) => occurrence.tags.find((t) => t[0] === n)?.[1];
  expect(occurrence.kind).toBe(31923);
  expect(tag("capacity")).toBe("3");
  expect(tag("i")).toBe("discord:1280532848604086365");
  expect(tag("client")).toBe("token-bot");
  // 08:30 Brussels on a September day is 06:30 UTC
  expect(new Date(Number(tag("start")) * 1000).toISOString()).toBe("2026-09-25T06:30:00.000Z");
});

Deno.test("member keys derive deterministically from the bot secret and never collide", async () => {
  const bot = generateSecretKey();
  const a1 = await deriveMemberSecretKey(bot, community.guildId, "111");
  const a2 = await deriveMemberSecretKey(bot, community.guildId, "111");
  const b = await deriveMemberSecretKey(bot, community.guildId, "222");
  const other = await deriveMemberSecretKey(generateSecretKey(), community.guildId, "111");
  expect(a1).toEqual(a2);
  expect(getPublicKey(a1)).not.toBe(getPublicKey(b));
  expect(getPublicKey(a1)).not.toBe(getPublicKey(other));
});

Deno.test("newest RSVP per attendee and slot wins across keys, so cancelling from another app works", () => {
  const botSecret = generateSecretKey();
  const bot = getPublicKey(botSecret);
  const siteSecret = generateSecretKey();
  const site = getPublicKey(siteSecret);
  const discordKeySecret = generateSecretKey(); // the bot-derived key
  const browserKeySecret = generateSecretKey(); // the website's browser key
  const discordKey = getPublicKey(discordKeySecret);
  const browserKey = getPublicKey(browserKeySecret);
  const member = { id: "111", username: "alice", displayName: "Alice" };

  const attestations = [
    finalizeEvent(buildAttestation(member, [discordKey], community, bot, new Date(1000e3)), botSecret),
    finalizeEvent(buildAttestation(member, [browserKey], community, site, new Date(1000e3)), siteSecret),
  ];
  const profiles = [finalizeEvent(buildProfile(member, new Date(1000e3)), discordKeySecret)];
  const rsvps = [
    finalizeEvent(buildRsvp("signup", community, bot, bot, DAY, slot, new Date(2000e3)), discordKeySecret), // signed up in Discord
    finalizeEvent(buildRsvp("cancel", community, bot, bot, DAY, slot, new Date(3000e3)), browserKeySecret), // cancelled on the website
    finalizeEvent(buildRsvp("signup", community, bot, bot, DAY, later, new Date(2500e3)), browserKeySecret), // signed up on the website
  ];

  const links = parseAttestations(attestations, [bot, site]);
  expect(links).toHaveLength(1);
  expect(links[0].keys.sort()).toEqual([discordKey, browserKey].sort());

  const state = parseRsvps(rsvps, bot, community, [DAY], slots, links, parseProfiles(profiles));
  const first = state.find((s) => s.slotCode === "0830")!;
  const second = state.find((s) => s.slotCode === "1130")!;
  expect(first.discordId).toBe("111");
  expect(first.status).toBe("declined");
  expect(second.status).toBe("accepted");
  expect(second.name).toBe("Alice"); // named through the profile of the bot-derived key
});

Deno.test("RSVPs from untrusted providers stay anonymous and on-behalf RSVPs need a steward", () => {
  const botSecret = generateSecretKey();
  const bot = getPublicKey(botSecret);
  const strangerSecret = generateSecretKey();
  const stranger = getPublicKey(strangerSecret);
  const rogueProvider = generateSecretKey();
  const attestations = [finalizeEvent(buildAttestation({ id: "999", username: "x", displayName: "X" }, [stranger], community, getPublicKey(rogueProvider)), rogueProvider)];
  const onBehalf = buildRsvp("signup", community, bot, bot, DAY, slot);
  onBehalf.tags.push(["discord", "555"], ["name", "Someone"]);
  const rsvps = [
    finalizeEvent(buildRsvp("signup", community, bot, bot, DAY, slot), strangerSecret),
    finalizeEvent(onBehalf, strangerSecret),
  ];
  const state = parseRsvps(rsvps, bot, community, [DAY], slots, parseAttestations(attestations, [bot]), []);
  expect(state).toHaveLength(1);
  expect(state[0].discordId).toBeUndefined();
  expect(state[0].pubkey).toBe(stranger);
});
