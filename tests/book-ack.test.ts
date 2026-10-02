import { expect } from "@std/expect/expect";
import { bookStates, handleBookButton, handleBookSelect } from "../src/commands/book.ts";

/** A minimal stand-in for a discord.js button or select interaction that records what the bot does. */
function fakeClick(kind: "button" | "select", customId: string, values: string[] = []) {
  const calls: string[] = [];
  const i: any = {
    customId,
    values,
    deferred: false,
    replied: false,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => false,
    isRepliable: () => true,
    deferUpdate: () => { calls.push("deferUpdate"); i.deferred = true; return Promise.resolve(); },
    update: (d: any) => { calls.push("update:" + (d.content ?? "").slice(0, 30)); i.replied = true; return Promise.resolve(); },
    editReply: (d: any) => { calls.push("editReply:" + (d.content ?? "").slice(0, 30)); return Promise.resolve(); },
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
