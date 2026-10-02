import { expect } from "@std/expect/expect";
import { bookStates, handleBookButton, handleBookSelect } from "../src/commands/book.ts";

/** A minimal stand-in for a discord.js button or select interaction that records what the bot does. */
function fakeClick(kind: "button" | "select", customId: string, values: string[] = []) {
  const calls: string[] = [];
  const i: any = {
    customId,
    values,
    user: { id: "u", username: "booker", displayName: "Booker" },
    deferred: false,
    replied: false,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferUpdate: () => { calls.push("deferUpdate"); i.deferred = true; return Promise.resolve(); },
    update: (d: any) => { calls.push("update:" + (d.content ?? "").slice(0, 30)); i.replied = true; return Promise.resolve(); },
    editReply: (d: any) => { calls.push("editReply:" + (d.content ?? "").slice(0, 30)); i.last = d; return Promise.resolve(); },
    showModal: () => { calls.push("showModal"); return Promise.resolve(); },
  };
  return { i, calls };
}

Deno.test("a /book click is acknowledged first, then the message is edited", async () => {
  bookStates.set("u1", { step: "room", guildId: "g" });
  const { i, calls } = fakeClick("button", "book_cancel");
  await handleBookButton(i, "u1", "g");
  expect(calls[0]).toBe("deferUpdate");
  expect(calls[1]).toContain("editReply:❌ Booking cancelled");
  expect(calls.some((c) => c.startsWith("update:"))).toBe(false);
});

Deno.test("an expired session is still answered after acknowledging", async () => {
  bookStates.delete("u2");
  const { i, calls } = fakeClick("button", "book_room_mushroom");
  await handleBookButton(i, "u2", "g");
  expect(calls).toEqual(["deferUpdate", "editReply:⚠️ Session expired. Please run"]);
});

Deno.test("buttons that open a modal answer with the modal, not a deferral", async () => {
  bookStates.set("u3", { step: "date", guildId: "g", productSlug: "mushroom" });
  const date = fakeClick("button", "book_date_custom");
  await handleBookButton(date.i, "u3", "g");
  expect(date.calls).toEqual(["showModal"]);

  bookStates.set("u4", { step: "name", guildId: "g", productSlug: "mushroom" });
  const name = fakeClick("button", "book_custom_name");
  await handleBookButton(name.i, "u4", "g");
  expect(name.calls).toEqual(["showModal"]);
});

Deno.test("select menus are acknowledged too", async () => {
  bookStates.delete("u5");
  const { i, calls } = fakeClick("select", "book_time_select", ["10:00"]);
  await handleBookSelect(i, "u5", "g");
  expect(calls[0]).toBe("deferUpdate");
  expect(calls[1]).toContain("editReply:⚠️ Session expired");
});

// ── booking on behalf of someone ────────────────────────────────────────────

import { handleBookModal } from "../src/commands/book.ts";
import { getUserEmail } from "../src/lib/user-emails.ts";

const atNameStep = () => ({ step: "name" as const, guildId: "g", productSlug: "mushroom", selectedDate: new Date(2027, 0, 5), selectedHour: 10, selectedMinute: 0, duration: 60 });

function fakeModal(customId: string, fields: Record<string, string>) {
  const calls: string[] = [];
  const i: any = {
    customId, deferred: false, replied: false,
    user: { username: "booker", displayName: "Booker" },
    isButton: () => false, isStringSelectMenu: () => false, isUserSelectMenu: () => false,
    isModalSubmit: () => true, isRepliable: () => true,
    fields: { getTextInputValue: (k: string) => { if (!(k in fields)) throw new Error("no field " + k); return fields[k]; } },
    deferUpdate: () => { calls.push("deferUpdate"); i.deferred = true; return Promise.resolve(); },
    reply: (d: any) => { calls.push("reply:" + d.content.slice(0, 40)); i.replied = true; return Promise.resolve(); },
    editReply: (d: any) => { calls.push("editReply:" + d.content); i.last = d; return Promise.resolve(); },
  };
  return { i, calls };
}

Deno.test("'For a guest' opens its form without deferring", async () => {
  bookStates.set("b1", atNameStep());
  const { i, calls } = fakeClick("button", "book_for_guest");
  await handleBookButton(i, "b1", "g");
  expect(calls).toEqual(["showModal"]);
});

Deno.test("the guest form validates emails, records the guest and the booker's email", async () => {
  Deno.env.set("DATA_DIR", "./cache/test-data");
  bookStates.set("b2", atNameStep());
  const bad = fakeModal("book_guest_modal", { guest_name: "Ana", guest_email: "not-an-email", booker_email: "me@example.com" });
  await handleBookModal(bad.i, "b2", "g");
  expect(bad.calls[0]).toContain("reply:❌");
  expect(bookStates.get("b2")!.bookedFor).toBeUndefined();

  const ok = fakeModal("book_guest_modal", { guest_name: "Ana", guest_email: "Ana@Example.com", booker_email: "me@example.com" });
  await handleBookModal(ok.i, "b2", "g");
  expect(bookStates.get("b2")!.bookedFor).toEqual({ kind: "guest", name: "Ana", email: "ana@example.com" });
  expect(getUserEmail("g", "b2")).toBe("me@example.com");
  expect(ok.calls[0]).toBe("deferUpdate");
  expect(ok.calls[1]).toContain("**For:** Ana (guest)");
  const labels = ok.i.last.components.flatMap((row: any) => row.components.map((c: any) => c.data.label));
  expect(labels).toContain("For Ana (guest)");
});

Deno.test("'For another member' shows a member picker, and picking one records them", async () => {
  bookStates.set("b3", atNameStep());
  const pick = fakeClick("button", "book_for_member");
  await handleBookButton(pick.i, "b3", "g");
  expect(pick.calls[0]).toBe("deferUpdate");
  expect(pick.i.last.content).toContain("Who is this booking for?");

  const { i, calls } = fakeClick("select", "book_for_member_select", ["42"]);
  i.isStringSelectMenu = () => false;
  i.isUserSelectMenu = () => true;
  i.users = new Map([["42", { id: "42", username: "kris", globalName: "Kris", bot: false }]]);
  i.members = new Map([["42", { nick: null, displayName: "Kris Is" }]]);
  await handleBookSelect(i, "b3", "g");
  expect(bookStates.get("b3")!.bookedFor).toMatchObject({ kind: "member", discordUserId: "42", displayName: "Kris Is" });
  expect(i.last.content).toContain("**For:** <@42>");

  const me = fakeClick("button", "book_for_me");
  await handleBookButton(me.i, "b3", "g");
  expect(bookStates.get("b3")!.bookedFor).toBeUndefined();
});
