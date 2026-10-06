/**
 * Community tablet shifts: cancel tokens, member search, audit lines, confirmation email and DM.
 */
import { expect } from "@std/expect/expect";
import { buildCancelUrl, signCancelToken, verifyCancelToken } from "../src/lib/shift-cancel-token.ts";
import { matchRank, normalizeName, searchMembers } from "../src/lib/shifts-api.ts";
import { buildShiftCancelledDm, buildShiftDm, buildShiftEmail, HANDBOOK_URL } from "../src/lib/shift-email.ts";
import { isCancelledShiftEvent, parseShiftSignups, signupAuditLine, slotFor } from "../src/commands/shifts.ts";

const KEY = "test-secret";

// ── Cancel tokens ────────────────────────────────────────────────────────────

Deno.test("cancel token: round trip, tamper, wrong key, expiry", async () => {
  const claims = { calendarEventId: "evt_123", discordUserId: "689614876515237925", exp: 2_000_000_000 };
  const token = await signCancelToken(claims, KEY);
  expect(token.split(".").length).toBe(2);
  expect(token).not.toMatch(/[+/=]/); // URL-safe

  expect(await verifyCancelToken(token, new Date(1_900_000_000_000), KEY)).toEqual({ ok: true, claims });
  expect(await verifyCancelToken(token, new Date(1_900_000_000_000), "other-key")).toEqual({ ok: false, reason: "bad_signature" });
  expect(await verifyCancelToken(token, new Date(2_000_000_001_000), KEY)).toEqual({ ok: false, reason: "expired" });

  // Someone swaps the user id in the payload: the signature no longer matches.
  const [, sig] = token.split(".");
  const forged = btoa(JSON.stringify({ e: "evt_123", u: "111", x: 2_000_000_000 })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  expect(await verifyCancelToken(`${forged}.${sig}`, new Date(1_900_000_000_000), KEY)).toEqual({ ok: false, reason: "bad_signature" });

  for (const bad of ["", "abc", "a.b.c", "###.###"]) {
    expect((await verifyCancelToken(bad, new Date(), KEY)).ok).toBe(false);
  }
});

Deno.test("cancel URL points at the website's cancel page", async () => {
  const url = await buildCancelUrl({ calendarEventId: "e", discordUserId: "1", exp: 2_000_000_000 }, KEY);
  expect(url.startsWith("https://commonshub.brussels/shifts/cancel?t=")).toBe(true);
  const token = decodeURIComponent(new URL(url).searchParams.get("t")!);
  expect((await verifyCancelToken(token, new Date(1_900_000_000_000), KEY)).ok).toBe(true);
});

// ── Member search ───────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
function fakeMember(id: string, displayName: string, username: string, globalName: string | null = null, bot = false): any {
  return {
    id,
    displayName,
    user: { username, globalName, bot },
    displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}.png`,
  };
}

const MEMBERS = [
  fakeMember("1", "Marlène Dupont", "marlene_d"),
  fakeMember("2", "Alain", "alain.b"),
  fakeMember("3", "Doug", "dougie", "Douglas"),
  fakeMember("4", "Elinor", "elinor-bot", null, true),
  fakeMember("5", "Anne-Marie", "annemarie"),
  fakeMember("6", "Xavier", "xdamman"),
];

Deno.test("normalizeName strips accents and case", () => {
  expect(normalizeName("  Marlène ")).toBe("marlene");
  expect(normalizeName("ÉLODIE")).toBe("elodie");
});

Deno.test("matchRank: prefix first, then word prefix, then contains", () => {
  expect(matchRank(["Marlène Dupont"], "mar")).toBe(0);
  expect(matchRank(["Marlène Dupont"], "dup")).toBe(1);
  expect(matchRank(["Marlène Dupont"], "lene")).toBe(2);
  expect(matchRank(["Marlène Dupont"], "zzz")).toBeNull();
  expect(matchRank(["Doug", "Douglas", "dougie"], "douglas")).toBe(0);
});

Deno.test("searchMembers: accent-insensitive, prefix first, bots excluded, limit", () => {
  expect(searchMembers(MEMBERS, "marle", 20, () => undefined).map((m) => m.id)).toEqual(["1"]);
  expect(searchMembers(MEMBERS, "MARLÈNE", 20, () => undefined).map((m) => m.id)).toEqual(["1"]);
  // "a": Alain and Anne-Marie start with it; Marlène (contains) comes after.
  const a = searchMembers(MEMBERS, "a", 20, () => undefined).map((m) => m.displayName);
  expect(a.slice(0, 2)).toEqual(["Alain", "Anne-Marie"]);
  expect(a).toContain("Marlène Dupont");
  expect(searchMembers(MEMBERS, "eli", 20, () => undefined)).toEqual([]); // bot
  expect(searchMembers(MEMBERS, "a", 1, () => undefined).length).toBe(1);
  expect(searchMembers(MEMBERS, "doug", 20, () => undefined)[0]).toEqual({
    id: "3", username: "dougie", displayName: "Doug", avatar: "https://cdn.discordapp.com/avatars/3.png",
  });
});

Deno.test("searchMembers without a query: recently seen members first", () => {
  const seen: Record<string, string> = { "6": "2026-10-05T10:00:00Z", "2": "2026-10-01T10:00:00Z" };
  const ids = searchMembers(MEMBERS, "", 3, (id) => seen[id]).map((m) => m.id);
  expect(ids).toEqual(["6", "2", "5"]); // then alphabetical: Anne-Marie
});

// ── Audit line stays compatible with the existing parser ─────────────────────

Deno.test("tablet audit line: parsed as a sign-up with the discord id, then cancellable", () => {
  const member = { id: "689614876515237925", username: "xdamman", displayName: "Xavier" };
  const line = signupAuditLine(member, { via: "tablet", eventTitle: "Climate Fresk", timestamp: "06/10/2026 18:00" });
  expect(line).toBe("06/10/2026 18:00: Xavier <@xdamman> signed up (discord:689614876515237925) via the community tablet to steward Climate Fresk");
  expect(parseShiftSignups(line)).toEqual([{ discordUserId: "689614876515237925", username: "xdamman" }]);
  expect(parseShiftSignups(`${line}\n06/10/2026 18:05: Xavier <@xdamman> cancelled`)).toEqual([]);

  const plain = signupAuditLine(member, { timestamp: "06/10/2026 18:00" });
  expect(plain).toBe("06/10/2026 18:00: Xavier <@xdamman> signed up (discord:689614876515237925)");
  expect(signupAuditLine(member, { eventTitle: "Line\nbreak", timestamp: "t" })).toContain("to steward Line break");
});

Deno.test("slotFor uses the shifts timezone, and cancelled events are recognised", () => {
  // 15:30Z = 17:30 in Brussels (summer time)
  expect(slotFor(new Date("2026-10-07T15:30:00Z"), new Date("2026-10-07T18:30:00Z"), "Europe/Brussels"))
    .toEqual({ start: "17:30", end: "20:30" });
  expect(isCancelledShiftEvent({ summary: "[Cancelled] Shift: 5:30PM-8:30PM" })).toBe(true);
  expect(isCancelledShiftEvent({ summary: "Shift: 5:30PM-8:30PM" })).toBe(false);
});

// ── Email and DM ────────────────────────────────────────────────────────────

const SAMPLE = {
  memberName: "Xavier",
  email: "x@example.com",
  start: new Date("2026-10-07T15:30:00Z"),
  end: new Date("2026-10-07T18:30:00Z"),
  timezone: "Europe/Brussels",
  eventTitle: "Climate Fresk",
  reward: { amount: 3, symbol: "CHT" },
  doorLink: "https://door.commonshub.brussels/open?x=1",
  cancelUrl: "https://commonshub.brussels/shifts/cancel?t=abc",
  calendarEventId: "evt_1",
  via: "tablet" as const,
};

Deno.test("shift email: subject, practical details, why shifts matter, handbook, cancel", () => {
  const { subject, html, text } = buildShiftEmail(SAMPLE);
  expect(subject).toBe("You're on shift: Wed 7 Oct, 17:30–20:30 at the Commons Hub");
  expect(text).toContain("When: Wednesday 7 October 2026, 17:30–20:30");
  expect(text).toContain("Where: Rue de la Madeleine 51, 1000 Brussels (right in front of Brussels Central Station)");
  expect(text).toContain("You steward: Climate Fresk");
  expect(text).toContain("Reward: 3 tokens (CHT), to claim after the shift as usual");
  expect(text).toContain("Open the door: https://door.commonshub.brussels/open?x=1");
  expect(text).toContain(`"we never have the opportunity to make a good first impression twice"`);
  expect(text).toContain("community of users of the space who keep coming back");
  expect(text).toContain(`Handbook: ${HANDBOOK_URL}`);
  expect(text).toContain("Ask Elinor on Discord, or post in #shifts");
  expect(text).toContain("Can't make it, or it wasn't you? Cancel with the link below, or with /shifts on Discord.");
  expect(text).toContain("Cancel: https://commonshub.brussels/shifts/cancel?t=abc");
  expect(text).toContain("signed you up for a caretaking shift at the community tablet");
  expect(html).toContain(`href="${HANDBOOK_URL}"`);
  expect(html).toContain("&quot;we never have the opportunity to make a good first impression twice&quot;");
  expect(html).toContain("🚪 Open the door");
  expect(html).toContain("Cancel this shift");

  const own = buildShiftEmail({ ...SAMPLE, via: "discord", eventTitle: undefined, doorLink: null, cancelUrl: undefined });
  expect(own.text).toContain("You signed up for a caretaking shift.");
  expect(own.text).not.toContain("You steward:");
  expect(own.text).not.toContain("GETTING IN");
  expect(own.text).toContain("Can't make it? Cancel with /shifts on Discord.");
  expect(buildShiftEmail({ ...SAMPLE, reward: { amount: 1, symbol: "CHT" } }).text).toContain("Reward: 1 token (CHT)");
});

Deno.test("shift email is sent to the member with an .ics", async () => {
  const { sendShiftConfirmation } = await import("../src/lib/shift-email.ts");
  const sent: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  Deno.env.set("RESEND_API_KEY", "test");
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify({ id: "m1" }), { status: 200 }));
  }) as typeof fetch;
  try {
    expect(await sendShiftConfirmation(SAMPLE)).toEqual({ id: "m1" });
    // deno-lint-ignore no-explicit-any
    const msg = sent[0] as any;
    expect(msg.to).toEqual(["x@example.com"]);
    expect(msg.attachments[0].filename).toBe("commonshub-shift.ics");
    const ics = new TextDecoder().decode(Uint8Array.from(atob(msg.attachments[0].content), (c) => c.charCodeAt(0)));
    expect(ics).toContain("UID:evt_1@commonshub.brussels");
    expect(ics).toContain("DTSTART:20261007T153000Z");
    expect(ics).toContain("SUMMARY:Caretaking shift: Climate Fresk (Commons Hub Brussels)");
  } finally {
    globalThis.fetch = real;
    Deno.env.delete("RESEND_API_KEY");
  }
  await expect(sendShiftConfirmation({ ...SAMPLE, email: undefined })).rejects.toThrow("no email address");
});

Deno.test("DMs: sign-up with cancel link, and cancellation", () => {
  const dm = buildShiftDm(SAMPLE);
  expect(dm).toContain("You're on shift: Wednesday 7 October 2026, 17:30–20:30");
  expect(dm).toContain("signed up at the community tablet");
  expect(dm).toContain("You steward: **Climate Fresk**");
  expect(dm).toContain("Reward: 3 tokens (CHT)");
  expect(dm).toContain("Open the door: <https://door.commonshub.brussels/open?x=1>");
  expect(dm).toContain("Not you, or can't make it? Cancel: <https://commonshub.brussels/shifts/cancel?t=abc>");
  expect(buildShiftCancelledDm(SAMPLE.start, SAMPLE.end)).toBe(
    "❌ Your shift on **Wednesday 7 October 2026, 17:30–20:30** at the Commons Hub was cancelled.",
  );
});
