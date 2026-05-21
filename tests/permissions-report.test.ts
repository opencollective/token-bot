import { assertEquals } from "jsr:@std/assert@1.0.13";
import { buildUserPermissionReport, formatUserPermissionReport } from "../src/lib/permissions.ts";
import type { GuildSettings, Product } from "../src/types.ts";

const guildSettings: GuildSettings = {
  guild: { id: "guild-1", name: "Test Guild", icon: null, timezone: "Europe/Brussels" },
  creator: { id: "creator", username: "creator", globalName: null, avatar: null },
  channels: { transactions: "tx", contributions: "contrib", logs: "logs" },
  tokens: [
    {
      name: "Commons Hub Token",
      symbol: "CHT",
      decimals: 18,
      chain: "base",
      address: "0x0000000000000000000000000000000000000001",
      mintable: true,
      minterRoleId: "role-minter",
    },
    {
      name: "Other Token",
      symbol: "OT",
      decimals: 18,
      chain: "base",
      address: "0x0000000000000000000000000000000000000002",
      mintable: true,
    },
    {
      name: "Non Mintable",
      symbol: "NOPE",
      decimals: 18,
      chain: "base",
      address: "0x0000000000000000000000000000000000000003",
      mintable: false,
    },
  ],
};

const rooms: Product[] = [
  {
    type: "room",
    unit: "hour",
    slug: "studio",
    name: "Studio",
    availabilities: "weekday",
    calendarId: "studio-calendar",
    price: [{ token: "CHT", amount: 10 }],
  },
  {
    type: "room",
    unit: "hour",
    slug: "disabled-room",
    name: "Disabled Room",
    availabilities: "weekday",
    calendarId: "disabled-calendar",
    price: [{ token: "CHT", amount: 10 }],
  },
];

Deno.test("permission report shows member token, room, and shift abilities", () => {
  const report = buildUserPermissionReport({
    userId: "user-1",
    isAdministrator: false,
    roleIds: ["role-minter"],
    guildSettings,
    products: rooms,
    shiftsSettings: {
      calendarId: "shifts-calendar",
      shiftsMasterRoleId: "role-shifts-master",
    },
    disabledCalendarIds: new Set(["disabled-calendar"]),
  });

  assertEquals(report.actions.issueTokens.allowed, true);
  assertEquals(report.actions.issueTokens.tokens.map((t) => [t.symbol, t.allowed]), [
    ["CHT", true],
    ["OT", false],
  ]);
  assertEquals(report.actions.bookRoom.allowed, true);
  assertEquals(report.actions.bookRoom.rooms.map((r) => r.slug), ["studio"]);
  assertEquals(report.actions.signUpForShift.allowed, true);
  assertEquals(report.actions.createRetroactiveShift.allowed, false);
});

Deno.test("permission report gives admins all token and shift-master abilities", () => {
  const report = buildUserPermissionReport({
    userId: "admin",
    isAdministrator: true,
    roleIds: [],
    guildSettings,
    products: rooms,
    shiftsSettings: {
      calendarId: "shifts-calendar",
      shiftsMasterRoleId: "role-shifts-master",
    },
    disabledCalendarIds: new Set<string>(),
  });

  assertEquals(report.actions.issueTokens.allowed, true);
  assertEquals(report.actions.issueTokens.tokens.map((t) => [t.symbol, t.allowed]), [
    ["CHT", true],
    ["OT", true],
  ]);
  assertEquals(report.actions.rewardShift.allowed, true);
  assertEquals(report.actions.createRetroactiveShift.allowed, true);
});

Deno.test("permission report treats CHT minters as shift masters", () => {
  const report = buildUserPermissionReport({
    userId: "cht-minter",
    isAdministrator: false,
    roleIds: ["1480923356013269044"],
    guildSettings,
    products: [],
    shiftsSettings: {
      calendarId: "shifts-calendar",
      shiftsMasterRoleId: "role-shifts-master",
    },
    disabledCalendarIds: new Set<string>(),
  });

  assertEquals(report.actions.rewardShift.allowed, true);
  assertEquals(report.actions.createRetroactiveShift.allowed, true);
});

Deno.test("permission report formats a user-readable summary", () => {
  const report = buildUserPermissionReport({
    userId: "user-1",
    isAdministrator: false,
    roleIds: ["role-minter"],
    guildSettings,
    products: rooms,
    shiftsSettings: undefined,
    disabledCalendarIds: new Set(["disabled-calendar"]),
  });

  const summary = formatUserPermissionReport(report);

  assertEquals(summary.includes("<@user-1>"), true);
  assertEquals(summary.includes("✅ Issue tokens: CHT"), true);
  assertEquals(summary.includes("✅ Book a room: Studio"), true);
  assertEquals(summary.includes("❌ Sign up for a shift: shifts are not configured"), true);
  assertEquals(summary.includes("❌ Create retroactive shifts"), true);
});
