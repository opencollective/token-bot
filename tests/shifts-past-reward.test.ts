import { expect } from "@std/expect/expect";
import {
  buildShiftSignupUpsert,
  buildShiftTransactionMessage,
  getPastShiftStartOptions,
} from "../src/commands/shifts.ts";

Deno.test("past shift start options list every half hour instead of regular shift slots", () => {
  const options = getPastShiftStartOptions();

  expect(options.slice(0, 5)).toEqual([
    { label: "8am", value: "08:00" },
    { label: "8:30am", value: "08:30" },
    { label: "9am", value: "09:00" },
    { label: "9:30am", value: "09:30" },
    { label: "10am", value: "10:00" },
  ]);
  expect(options.at(-1)).toEqual({ label: "8pm", value: "20:00" });
  expect(options).toHaveLength(25);
});

Deno.test("past shift upsert updates existing calendar event like a normal signup", () => {
  const selectedDate = new Date(2026, 4, 20);
  const selectedSlot = { start: "09:00", end: "11:00" };
  const participants = [
    { discordUserId: "111", username: "alice", email: "alice@example.com" },
    { discordUserId: "222", username: "bob" },
  ];

  const result = buildShiftSignupUpsert({
    existingEvent: {
      id: "evt_1",
      summary: "Shift: 09:00-11:00",
      description: "Earlier note",
      start: { dateTime: new Date(2026, 4, 20, 9, 0).toISOString() },
      end: { dateTime: new Date(2026, 4, 20, 11, 0).toISOString() },
      attendees: [{ email: "existing@example.com" }],
    },
    selectedDate,
    selectedSlot,
    timezone: "Europe/Brussels",
    participants,
    recorderName: "Recorder <@recorder>",
    timestamp: "20/05/2026 12:34",
    retroactive: true,
  });

  expect(result.action).toBe("update");
  expect(result.event.id).toBe("evt_1");
  expect(result.payload.description).toContain("Earlier note");
  expect(result.payload.description).toContain(
    "20/05/2026 12:34: <@alice> signed up (discord:111) retroactively by Recorder <@recorder>",
  );
  expect(result.payload.description).toContain(
    "20/05/2026 12:34: <@bob> signed up (discord:222) retroactively by Recorder <@recorder>",
  );
  expect(result.payload.attendees).toEqual([
    { email: "existing@example.com" },
    { email: "alice@example.com" },
  ]);
});

Deno.test("past shift upsert creates calendar event when none exists", () => {
  const result = buildShiftSignupUpsert({
    selectedDate: new Date(2026, 4, 20),
    selectedSlot: { start: "09:00", end: "11:00" },
    timezone: "Europe/Brussels",
    participants: [{ discordUserId: "111", username: "alice", email: "alice@example.com" }],
    recorderName: "Recorder <@recorder>",
    timestamp: "20/05/2026 12:34",
    retroactive: true,
  });

  expect(result.action).toBe("create");
  expect(result.payload.summary).toBe("Shift: 9:00AM-11:00AM");
  expect(result.payload.location).toContain("Commons Hub Brussels");
  expect(result.payload.description).toContain(
    "<@alice> signed up (discord:111) retroactively by Recorder <@recorder>",
  );
  expect(result.payload.attendees).toEqual([{ email: "alice@example.com" }]);
});

Deno.test("shift reward transaction message targets CHT transaction channel format", () => {
  const message = buildShiftTransactionMessage({
    minterUserId: "999",
    rewards: [
      { userId: "111", username: "alice", amount: 20, hash: "0xaaa" },
      { userId: "222", username: "bob", amount: 20, hash: "0xbbb" },
    ],
    token: {
      symbol: "CHT",
      chain: "celo",
      address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d",
      transactionsChannelId: "1354115945718878269",
    },
    shiftStart: new Date(2026, 4, 20, 9, 0),
    shiftEnd: new Date(2026, 4, 20, 11, 0),
  });

  expect(message.channelId).toBe("1354115945718878269");
  expect(message.content).toContain(
    "<@999> issued 20 CHT to <@111>, <@222> for a 2h shift on 20/05/2026 at 09:00",
  );
});

Deno.test("shift reward transaction message defaults CHT rewards to #cht-transactions", () => {
  const message = buildShiftTransactionMessage({
    minterUserId: "999",
    rewards: [{ userId: "111", username: "alice", amount: 20, hash: "0xaaa" }],
    token: {
      symbol: "CHT",
      chain: "celo",
      address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d",
    },
    shiftStart: new Date(2026, 4, 20, 9, 0),
    shiftEnd: new Date(2026, 4, 20, 11, 0),
  });

  expect(message.channelId).toBe("1354115945718878269");
});
