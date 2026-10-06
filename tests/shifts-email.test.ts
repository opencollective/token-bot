/**
 * /shifts sign-ups: audit line, slot times, and the confirmation email with its .ics.
 */
import { expect } from "@std/expect/expect";
import { buildShiftEmail, HANDBOOK_URL, sendShiftConfirmation } from "../src/lib/shift-email.ts";
import { isCancelledShiftEvent, parseShiftSignups, signupAuditLine, slotFor } from "../src/commands/shifts.ts";

Deno.test("audit line: parsed as a sign-up with the discord id, then cancellable", () => {
  const member = { id: "689614876515237925", username: "xdamman", displayName: "Xavier" };
  const line = signupAuditLine(member, "06/10/2026 18:00");
  expect(line).toBe("06/10/2026 18:00: Xavier <@xdamman> signed up (discord:689614876515237925)");
  expect(parseShiftSignups(line)).toEqual([{ discordUserId: "689614876515237925", username: "xdamman" }]);
  expect(parseShiftSignups(`${line}\n06/10/2026 18:05: Xavier <@xdamman> cancelled`)).toEqual([]);
});

Deno.test("slotFor uses the shifts timezone, and cancelled events are recognised", () => {
  // 15:30Z = 17:30 in Brussels (summer time)
  expect(slotFor(new Date("2026-10-07T15:30:00Z"), new Date("2026-10-07T18:30:00Z"), "Europe/Brussels"))
    .toEqual({ start: "17:30", end: "20:30" });
  expect(isCancelledShiftEvent({ summary: "[Cancelled] Shift: 5:30PM-8:30PM" })).toBe(true);
  expect(isCancelledShiftEvent({ summary: "Shift: 5:30PM-8:30PM" })).toBe(false);
});

const SAMPLE = {
  memberName: "Xavier",
  email: "x@example.com",
  start: new Date("2026-10-07T15:30:00Z"),
  end: new Date("2026-10-07T18:30:00Z"),
  timezone: "Europe/Brussels",
  reward: { amount: 3, symbol: "CHT" },
  doorLink: "https://door.commonshub.brussels/open?x=1",
  calendarEventId: "evt_1",
};

Deno.test("shift email: subject, practical details, why shifts matter, handbook, how to cancel", () => {
  const { subject, html, text } = buildShiftEmail(SAMPLE);
  expect(subject).toBe("You're on shift: Wed 7 Oct, 17:30–20:30 at the Commons Hub");
  expect(text).toContain("You signed up for a caretaking shift.");
  expect(text).toContain("When: Wednesday 7 October 2026, 17:30–20:30");
  expect(text).toContain("Where: Rue de la Madeleine 51, 1000 Brussels (right in front of Brussels Central Station)");
  expect(text).toContain("Reward: 3 tokens (CHT), to claim after the shift as usual");
  expect(text).toContain("Open the door: https://door.commonshub.brussels/open?x=1");
  expect(text).toContain(`"we never have the opportunity to make a good first impression twice"`);
  expect(text).toContain("community of users of the space who keep coming back");
  expect(text).toContain(`Handbook: ${HANDBOOK_URL}`);
  expect(text).toContain("Ask Elinor on Discord, or post in #shifts");
  expect(text).toContain("Can't make it? Cancel with /shifts on Discord.");
  expect(html).toContain(`href="${HANDBOOK_URL}"`);
  expect(html).toContain("🚪 Open the door");
  for (const t of [html, text]) expect(t).not.toContain("tablet");

  const noDoor = buildShiftEmail({ ...SAMPLE, doorLink: null });
  expect(noDoor.text).not.toContain("GETTING IN");
  expect(buildShiftEmail({ ...SAMPLE, reward: { amount: 1, symbol: "CHT" } }).text).toContain("Reward: 1 token (CHT)");
});

Deno.test("shift email is sent to the member with an .ics", async () => {
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
    expect(ics).toContain("SUMMARY:Caretaking shift (Commons Hub Brussels)");
  } finally {
    globalThis.fetch = real;
    Deno.env.delete("RESEND_API_KEY");
  }
  await expect(sendShiftConfirmation({ ...SAMPLE, email: undefined })).rejects.toThrow("no email address");
});
