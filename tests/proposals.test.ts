/**
 * Elinor proposals: the pending-request store, the MCP tools, and proposal rules against a fake
 * Discord client (who may confirm, where the prompt goes, what gets logged).
 */
import { expect } from "@std/expect/expect";
import { getMcpTools, handleMcpRequest, validateArguments } from "../src/mcp/server.ts";
import {
  _resetCache,
  countPendingFor,
  createRequest,
  findExpired,
  getRequest,
  newRequestId,
  publicStatus,
  REQUEST_TTL_MS,
  transition,
} from "../src/lib/pending-requests.ts";
import { promptText, proposeMint, setProposalsClient, whenText } from "../src/lib/proposals.ts";

// ── Test fixtures ───────────────────────────────────────────────────────────

const DATA = await Deno.makeTempDir();
Deno.env.set("DATA_DIR", DATA);

function mcp(body: unknown) {
  return new Request("http://localhost/mcp", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

const noop = () => Promise.resolve({});
const ALL_EXECUTORS = {
  checkUserPermissions: noop,
  listRooms: noop,
  checkRoomAvailability: noop,
  listUpcomingShifts: noop,
  proposeMint: noop,
  proposeShiftSignup: noop,
  proposeRoomBooking: noop,
  getRequestStatus: noop,
};

// ── MCP server ──────────────────────────────────────────────────────────────

Deno.test("MCP lists every tool when executors exist, only those with an executor otherwise", () => {
  expect(getMcpTools(ALL_EXECUTORS).map((t) => t.name)).toEqual([
    "check_user_permissions", "list_rooms", "check_room_availability", "list_upcoming_shifts",
    "propose_mint", "propose_shift_signup", "propose_room_booking", "get_request_status",
  ]);
  expect(getMcpTools({ checkUserPermissions: noop }).map((t) => t.name)).toEqual(["check_user_permissions"]);
});

Deno.test("MCP initialize negotiates the protocol version", async () => {
  const known = await (await handleMcpRequest(mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }), ALL_EXECUTORS)).json();
  expect(known.result.protocolVersion).toBe("2025-03-26");
  const unknown = await (await handleMcpRequest(mcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }), ALL_EXECUTORS)).json();
  expect(unknown.result.protocolVersion).toBe("2025-06-18");
  expect(unknown.result.instructions).toContain("Confirm or Cancel");
});

Deno.test("MCP notifications get 202, batches get an array without notification replies", async () => {
  const note = await handleMcpRequest(mcp({ jsonrpc: "2.0", method: "notifications/initialized" }), ALL_EXECUTORS);
  expect(note.status).toBe(202);
  const batch = await handleMcpRequest(mcp([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]), ALL_EXECUTORS);
  const replies = await batch.json();
  expect(replies.map((r: { id: number }) => r.id)).toEqual([1, 2]);
});

Deno.test("MCP validates arguments against the tool schema before running it", async () => {
  let ran = false;
  const executors = { ...ALL_EXECUTORS, proposeMint: () => { ran = true; return Promise.resolve({}); } };
  const call = async (args: unknown) =>
    (await (await handleMcpRequest(mcp({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "propose_mint", arguments: args } }), executors)).json());

  const base = { guildId: "g", confirmerUserId: "1", recipientUserIds: ["2"], amount: 3, requestedBy: "elinor" };
  expect((await call({ ...base, recipientUserIds: undefined })).error.message).toBe("Missing required array argument: recipientUserIds");
  expect((await call({ ...base, amount: "3" })).error.message).toBe("Argument amount must be a number");
  expect((await call({ ...base, amount: 0 })).error.message).toBe("Argument amount must be > 0");
  expect((await call({ ...base, recipientUserIds: [] })).error.message).toBe("Argument recipientUserIds needs at least 1 item(s)");
  expect((await call({ ...base, recipientUserIds: [2] })).error.message).toBe("Argument recipientUserIds must be an array of strings");
  expect((await call({ ...base, sneaky: true })).error.message).toBe("Unknown argument: sneaky");
  expect(ran).toBe(false);
  expect((await call(base)).result.content[0].type).toBe("text");
  expect(ran).toBe(true);
});

Deno.test("MCP tool errors come back as isError results, not protocol errors", async () => {
  const res = await (await handleMcpRequest(mcp({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "get_request_status", arguments: { requestId: "req_x" } },
  }), { ...ALL_EXECUTORS, getRequestStatus: () => Promise.reject(new Error("Unknown request req_x")) })).json();
  expect(res.result.isError).toBe(true);
  expect(res.result.content[0].text).toBe("Unknown request req_x");
});

Deno.test("validateArguments: integer bounds", () => {
  const schema = getMcpTools(ALL_EXECUTORS).find((t) => t.name === "list_upcoming_shifts")!.inputSchema;
  expect(validateArguments(schema, { guildId: "g", days: 40 })).toBe("Argument days must be ≤ 31");
  expect(validateArguments(schema, { guildId: "g", days: 1.5 })).toBe("Argument days must be an integer");
  expect(validateArguments(schema, { guildId: "g", days: 7 })).toBeNull();
});

// ── Pending requests ────────────────────────────────────────────────────────

Deno.test("pending requests: ids, 24 h expiry, single transition, persisted to disk", async () => {
  _resetCache();
  expect(newRequestId()).toMatch(/^req_[a-z2-9]{12}$/);
  const now = new Date("2026-10-07T10:00:00Z");
  const r = await createRequest({
    kind: "mint", guildId: "g-store", requestedBy: "elinor", confirmerId: "u1",
    params: { tokenSymbol: "CHT", recipientIds: ["u2"], amount: 1 }, summary: "Mint 1 CHT for <@u2>",
  }, now);
  expect(r.status).toBe("pending");
  expect(new Date(r.expiresAt).getTime() - now.getTime()).toBe(REQUEST_TTL_MS);
  expect(await countPendingFor("g-store", "u1")).toBe(1);

  // Two clicks race: only one wins.
  const [a, b] = await Promise.all([
    transition("g-store", r.id, "confirmed", "u1", now),
    transition("g-store", r.id, "cancelled", "u1", now),
  ]);
  expect([a?.status, b?.status].filter(Boolean)).toEqual(["confirmed"]);
  expect(await countPendingFor("g-store", "u1")).toBe(0);

  // Survives a restart (cache cleared → read from DATA_DIR).
  _resetCache();
  const reloaded = await getRequest(r.id, ["g-store"]);
  expect(reloaded?.status).toBe("confirmed");
  expect(reloaded?.decidedBy).toBe("u1");
  expect(publicStatus(reloaded!)).toMatchObject({ requestId: r.id, kind: "mint", status: "confirmed", decidedBy: "u1", messageUrl: null });
});

Deno.test("pending requests: confirming after expiry fails and marks it expired", async () => {
  _resetCache();
  const created = new Date("2026-10-07T10:00:00Z");
  const r = await createRequest({
    kind: "shift_signup", guildId: "g-exp", requestedBy: "elinor", confirmerId: "u1",
    params: { start: "2026-10-08T15:30:00Z", end: "2026-10-08T18:30:00Z" }, summary: "Shift",
  }, created);
  const later = new Date(created.getTime() + REQUEST_TTL_MS + 1000);
  expect((await findExpired(["g-exp"], later)).map((x) => x.id)).toEqual([r.id]);
  expect(await transition("g-exp", r.id, "confirmed", "u1", later)).toBeUndefined();
  expect((await getRequest(r.id, ["g-exp"]))?.status).toBe("expired");
  expect(await findExpired(["g-exp"], later)).toEqual([]);
});

Deno.test("prompt text: summary, who confirms, relative expiry", () => {
  const text = promptText({
    kind: "mint", confirmerId: "42", summary: "Mint **3 CHT** for <@7>",
    expiresAt: "2026-10-08T10:00:00.000Z", requestedBy: "elinor for <@42> in #general",
  });
  expect(text).toContain("Elinor proposes a mint** for <@42> to confirm");
  expect(text).toContain("Mint **3 CHT** for <@7>");
  expect(text).toContain("only <@42> can confirm · expires <t:1791453600:R>");
  expect(whenText(new Date("2026-10-07T15:30:00Z"), new Date("2026-10-07T18:30:00Z"))).toBe("Wednesday 7 October 2026, 17:30–20:30");
});

// ── propose_mint against a fake Discord client ──────────────────────────────

const GUILD = "1111111111";
const MINTER_ROLE = "role-minter";

// deno-lint-ignore no-explicit-any
function fakeMember(id: string, opts: { roles?: string[]; admin?: boolean; bot?: boolean } = {}): any {
  return {
    id,
    displayName: `user${id}`,
    user: { id, username: `user${id}`, globalName: null, bot: !!opts.bot },
    roles: { cache: new Set(opts.roles ?? []) },
    permissions: { has: () => !!opts.admin },
  };
}

function fakeClient() {
  _resetCache();
  try {
    Deno.removeSync(`${DATA}/${GUILD}/pending-requests.json`);
  } catch {
    // first test
  }
  const sent: { where: string; content: string; components?: unknown[] }[] = [];
  const members = new Map([
    ["2000000001", fakeMember("2000000001", { roles: [MINTER_ROLE] })], // steward
    ["2000000002", fakeMember("2000000002")], // member
    ["2000000003", fakeMember("2000000003")],
    ["2000000009", fakeMember("2000000009", { bot: true })],
  ]);
  const channel = (id: string, guildId = GUILD) => ({
    id, guildId, isTextBased: () => true,
    send: (m: { content: string; components?: unknown[] }) => {
      sent.push({ where: `channel:${id}`, ...m });
      return Promise.resolve({ id: `msg${sent.length}`, channelId: id });
    },
  });
  const client = {
    guilds: {
      cache: new Map([[GUILD, {}]]),
      fetch: (id: string) => id === GUILD
        ? Promise.resolve({ id: GUILD, name: "Test", members: { fetch: (uid: string) => members.has(uid) ? Promise.resolve(members.get(uid)) : Promise.reject(new Error("no")) } })
        : Promise.reject(new Error("no guild")),
    },
    channels: {
      fetch: (id: string) => Promise.resolve(id === "other-guild-chan" ? channel(id, "999") : channel(id)),
    },
    users: {
      fetch: (id: string) => Promise.resolve({
        send: (m: { content: string }) => {
          sent.push({ where: `dm:${id}`, ...m });
          return Promise.resolve({ id: `dm${sent.length}`, channelId: `dmchan-${id}` });
        },
      }),
    },
  };
  // deno-lint-ignore no-explicit-any
  setProposalsClient(client as any);
  return { sent };
}

await Deno.mkdir(`${DATA}/${GUILD}`, { recursive: true });
await Deno.writeTextFile(`${DATA}/${GUILD}/settings.json`, JSON.stringify({
  guild: { id: GUILD, name: "Test", icon: null },
  creator: { id: "1", username: "x", globalName: null, avatar: null },
  channels: { transactions: "", contributions: "", logs: "log-chan" },
  tokens: [
    { name: "Commons Hub Token", symbol: "CHT", decimals: 6, chain: "celo", address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d", mintable: true, minterRoleId: MINTER_ROLE },
    { name: "EURchb", symbol: "EURchb", decimals: 6, chain: "gnosis", address: "0x9ee438a16be3c75247aded9c80e801bf4764ca5c", mintable: true, minterRoleId: "role-eur" },
  ],
}));

const mintBase = { guildId: GUILD, confirmerUserId: "2000000001", recipientUserIds: ["2000000002", "2000000003"], amount: 2, token: "CHT", requestedBy: "elinor for <@2000000001>" };

Deno.test("propose_mint: needs a token when several are mintable, and a confirmer who can mint it", async () => {
  _resetCache();
  fakeClient();
  await expect(proposeMint({ ...mintBase, token: undefined })).rejects.toThrow("Several tokens are mintable; pass token (one of: CHT, EURchb)");
  await expect(proposeMint({ ...mintBase, token: "EURchb" })).rejects.toThrow("can't mint EURchb: it needs the <@&role-eur> role");
  await expect(proposeMint({ ...mintBase, confirmerUserId: "2000000002" })).rejects.toThrow("can't mint CHT");
  await expect(proposeMint({ ...mintBase, recipientUserIds: ["2000000009"] })).rejects.toThrow("recipient 2000000009 is a bot");
  await expect(proposeMint({ ...mintBase, recipientUserIds: ["nope"] })).rejects.toThrow("Unknown recipient");
});

Deno.test("propose_mint: posts Confirm/Cancel in the channel, mentions only the confirmer, logs it", async () => {
  _resetCache();
  const { sent } = fakeClient();
  const res = await proposeMint({ ...mintBase, channelId: "chan-1", description: "Cleaned the park" });
  expect(res.status).toBe("pending");
  expect(res.deliveredBy).toBe("channel");
  expect(res.messageUrl).toBe(`https://discord.com/channels/${GUILD}/chan-1/msg1`);

  const prompt = sent.find((s) => s.where === "channel:chan-1")!;
  expect(prompt.content).toContain("Mint **2 CHT** each for <@2000000002>, <@2000000003>");
  expect(prompt.content).toContain("📝 Cleaned the park");
  expect(prompt.content).toContain("only <@2000000001> can confirm");
  // deno-lint-ignore no-explicit-any
  const ids = (prompt.components as any[])[0].toJSON().components.map((c: { custom_id: string }) => c.custom_id);
  expect(ids).toEqual([`preq_confirm:${res.requestId}`, `preq_cancel:${res.requestId}`]);
  expect(sent.find((s) => s.where === "channel:log-chan")!.content).toContain(`Elinor proposed a mint (${res.requestId})`);

  // Nothing minted: the request just waits.
  expect((await getRequest(res.requestId, [GUILD]))?.status).toBe("pending");
});

Deno.test("propose_mint: falls back to a DM when the channel is in another server", async () => {
  _resetCache();
  const { sent } = fakeClient();
  const res = await proposeMint({ ...mintBase, channelId: "other-guild-chan" });
  expect(res.deliveredBy).toBe("dm");
  expect(sent.some((s) => s.where === "dm:2000000001")).toBe(true);
  expect(sent.some((s) => s.where === "channel:other-guild-chan")).toBe(false);
});

Deno.test("propose_mint: at most 10 pending requests per confirmer", async () => {
  _resetCache();
  fakeClient();
  for (let i = 0; i < 10; i++) await proposeMint({ ...mintBase, recipientUserIds: ["2000000002"], amount: i + 1 });
  await expect(proposeMint(mintBase)).rejects.toThrow("already has 10 pending requests");
});
