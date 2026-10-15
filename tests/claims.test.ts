/**
 * Token claims (/claim, propose_claim): validation, the message in the transactions channel, who may
 * approve or reject, and one decision only. The mint itself is stubbed.
 */
import { expect } from "@std/expect/expect";
import {
  _setClaimMint,
  checkClaimAmount,
  checkClaimCategory,
  claimBody,
  createClaim,
  handleClaimButton,
  handleClaimRejectModal,
  mentionedIds,
} from "../src/lib/claims.ts";
import { _resetCache, getRequest } from "../src/lib/pending-requests.ts";
import { getMcpTools, validateArguments } from "../src/mcp/server.ts";

const DATA = await Deno.makeTempDir();
Deno.env.set("DATA_DIR", DATA);
const GUILD = "3333333333";
const MINTER = "role-minter";
const TX_CHANNEL = "tx-chan";

await Deno.mkdir(`${DATA}/${GUILD}`, { recursive: true });
await Deno.writeTextFile(`${DATA}/${GUILD}/settings.json`, JSON.stringify({
  guild: { id: GUILD, name: "Test", icon: null },
  creator: { id: "1", username: "x", globalName: null, avatar: null },
  channels: { transactions: "", contributions: "", logs: "" },
  tokens: [
    { name: "Commons Hub Token", symbol: "CHT", decimals: 6, chain: "celo", address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d", mintable: true, minterRoleId: MINTER, transactionsChannelId: TX_CHANNEL },
  ],
}));

// deno-lint-ignore no-explicit-any
function fakeMember(id: string, opts: { roles?: string[]; bot?: boolean } = {}): any {
  return {
    id,
    displayName: `user${id}`,
    user: { id, username: `user${id}`, bot: !!opts.bot },
    roles: { cache: { has: (r: string) => (opts.roles ?? []).includes(r) } },
    permissions: { has: () => false },
  };
}

const ASKER = "4000000001"; // a minter
const OTHER_MINTER = "4000000002";
const ALAIN = "4000000003";
const LEEN = "4000000004";
const NOBODY = "4000000005";
const BOT = "4000000009";

function setup() {
  _resetCache();
  try {
    Deno.removeSync(`${DATA}/${GUILD}/pending-requests.json`);
  } catch {
    // first test
  }
  const members = new Map([
    [ASKER, fakeMember(ASKER, { roles: [MINTER] })],
    [OTHER_MINTER, fakeMember(OTHER_MINTER, { roles: [MINTER] })],
    [ALAIN, fakeMember(ALAIN)],
    [LEEN, fakeMember(LEEN)],
    [NOBODY, fakeMember(NOBODY)],
    [BOT, fakeMember(BOT, { bot: true })],
  ]);
  const sent: { channel: string; content: string; components?: unknown[]; allowedMentions?: unknown }[] = [];
  const guild = {
    id: GUILD,
    members: { fetch: (id: string) => (members.has(id) ? Promise.resolve(members.get(id)) : Promise.reject(new Error("no"))) },
  };
  const client = {
    guilds: { cache: new Map([[GUILD, guild]]), fetch: (id: string) => (id === GUILD ? Promise.resolve(guild) : Promise.reject(new Error("no"))) },
    channels: {
      fetch: (id: string) => Promise.resolve({
        id, guildId: GUILD, isTextBased: () => true, isThread: () => false,
        send: (m: { content: string }) => {
          sent.push({ channel: id, ...m });
          return Promise.resolve({ id: `msg${sent.length}`, channelId: id });
        },
      }),
    },
  };
  return { sent, client, guild };
}

/** A fake button/modal interaction; collects what the handler answered. */
// deno-lint-ignore no-explicit-any
function click(client: any, guild: any, userId: string, customId: string, reason = "") {
  const out: { replies: string[]; updates: string[]; modal?: unknown } = { replies: [], updates: [] };
  const interaction = {
    customId, client, guild, guildId: GUILD, user: { id: userId },
    reply: (m: { content: string }) => (out.replies.push(m.content), Promise.resolve()),
    update: (m: { content: string }) => (out.updates.push(m.content), Promise.resolve()),
    editReply: (m: { content: string }) => (out.updates.push(m.content), Promise.resolve()),
    showModal: (m: unknown) => ((out.modal = m), Promise.resolve()),
    isFromMessage: () => true,
    fields: { getTextInputValue: () => reason },
  };
  // deno-lint-ignore no-explicit-any
  return { interaction: interaction as any, out };
}

Deno.test("amounts: more than 0, at most 2 decimals, at most 10 per person", () => {
  expect(() => checkClaimAmount(0)).toThrow("more than 0");
  expect(() => checkClaimAmount(1.234)).toThrow("at most 2 decimals");
  expect(() => checkClaimAmount(200)).toThrow("At most 10 tokens per person");
  checkClaimAmount(2.5);
  checkClaimAmount(10);
});

Deno.test("mentions, categories and the claim text (tokens, never CHT)", () => {
  expect(mentionedIds("<@123456> and <@!789012>, <@123456>")).toEqual(["123456", "789012"]);
  expect(checkClaimCategory("Cleaning", "CHT")).toBe("cleaning");
  expect(checkClaimCategory("", "CHT")).toBeUndefined();
  expect(() => checkClaimCategory("parties", "CHT")).toThrow('Unknown category "parties"');
  const body = claimBody({ requesterId: "1", recipientIds: ["2", "3", "1"], amount: 2, reason: "cleaning", category: "cleaning", viaElinor: true });
  expect(body).toContain("🙋 **Token claim** by <@1> (via Elinor)");
  expect(body).toContain("**For:** <@2>, <@3>, <@1>");
  expect(body).toContain("**Amount:** 2 tokens each, 6 tokens in total");
  expect(body).toContain("🏷️ Cleaning");
  expect(body).not.toContain("CHT");
});

Deno.test("createClaim: defaults to the requester, posts in the transactions channel with buttons", async () => {
  const { sent, client } = setup();
  // deno-lint-ignore no-explicit-any
  const { request, url } = await createClaim({ client: client as any, guildId: GUILD, requesterId: NOBODY, amount: 1, reason: " watered  plants ", via: "command" });
  expect(request.kind).toBe("claim");
  expect(request.approval).toBe("any_minter");
  expect(url).toBe(`https://discord.com/channels/${GUILD}/${TX_CHANNEL}/msg1`);
  expect(sent[0].channel).toBe(TX_CHANNEL);
  expect(sent[0].content).toContain(`**For:** <@${NOBODY}>`);
  expect(sent[0].content).toContain("**Reason:** watered plants");
  expect(sent[0].content).toContain("⏳ Waiting for a minter (<@&role-minter>) to approve");
  expect(sent[0].allowedMentions).toEqual({ users: [NOBODY], roles: [] });
  expect(sent[0].components?.length).toBe(1);
  expect(new Date(request.expiresAt).getTime() - Date.now()).toBeGreaterThan(13 * 86400000);
});

Deno.test("createClaim: readable errors", async () => {
  const { client } = setup();
  // deno-lint-ignore no-explicit-any
  const base = { client: client as any, guildId: GUILD, requesterId: NOBODY, amount: 1, reason: "x", via: "command" as const };
  await expect(createClaim({ ...base, reason: "  " })).rejects.toThrow("A reason is required");
  await expect(createClaim({ ...base, amount: 50 })).rejects.toThrow("At most 10 tokens per person");
  await expect(createClaim({ ...base, recipientIds: [BOT] })).rejects.toThrow("is a bot");
  await expect(createClaim({ ...base, recipientIds: ["123"] })).rejects.toThrow("Unknown recipient");
  await expect(createClaim({ ...base, recipientIds: Array.from({ length: 21 }, (_, i) => String(5000000000 + i)) })).rejects.toThrow("At most 20 people");
});

Deno.test("approve: not by the requester, a recipient or a non-minter; another minter mints once", async () => {
  const { client, guild } = setup();
  const minted: { recipients: string[]; amount: number; description?: string; category?: string; tags?: string[][]; via?: string }[] = [];
  _setClaimMint((o) => {
    minted.push({ recipients: o.recipients.map((r) => r.id), amount: o.amount, description: o.description, category: o.category, tags: o.extraTags, via: o.source?.via });
    return Promise.resolve(o.recipients.map((r) => ({ recipient: r, success: true, hash: "0x" + "cd".repeat(32) })));
  });
  try {
    const { request } = await createClaim({
      // deno-lint-ignore no-explicit-any
      client: client as any, guildId: GUILD, requesterId: ASKER, recipientIds: [ALAIN, LEEN, ASKER], amount: 2, reason: "cleaning", category: "cleaning", via: "elinor",
    });
    const id = `claim:approve:${request.id}`;

    const byAsker = click(client, guild, ASKER, id);
    await handleClaimButton(byAsker.interaction);
    expect(byAsker.out.replies[0]).toContain("You asked for this claim");

    const byNobody = click(client, guild, NOBODY, id);
    await handleClaimButton(byNobody.interaction);
    expect(byNobody.out.replies[0]).toBe("Only a minter can approve a claim.");
    expect(minted).toEqual([]);

    const ok = click(client, guild, OTHER_MINTER, id);
    await handleClaimButton(ok.interaction);
    expect(minted).toEqual([{ recipients: [ALAIN, LEEN, ASKER], amount: 2, description: "cleaning", category: "cleaning", tags: [["t", "claim"]], via: "claim" }]);
    expect(ok.out.updates.at(-1)).toContain(`✅ Approved by <@${OTHER_MINTER}>`);
    expect(ok.out.updates.at(-1)).toContain("Minted 2 tokens for");
    expect(ok.out.updates.join("\n")).not.toContain("CHT");

    const again = click(client, guild, OTHER_MINTER, id);
    await handleClaimButton(again.interaction);
    expect(again.out.replies[0]).toBe("This claim is already confirmed.");
    expect(minted.length).toBe(1);
    expect((await getRequest(request.id, [GUILD]))?.status).toBe("confirmed");
  } finally {
    _setClaimMint();
  }
});

Deno.test("a minter who is a recipient can't approve; the requester can withdraw with a reason", async () => {
  const { client, guild } = setup();
  // deno-lint-ignore no-explicit-any
  const { request } = await createClaim({ client: client as any, guildId: GUILD, requesterId: ALAIN, recipientIds: [OTHER_MINTER], amount: 1, reason: "admin", via: "command" });

  const recipient = click(client, guild, OTHER_MINTER, `claim:approve:${request.id}`);
  await handleClaimButton(recipient.interaction);
  expect(recipient.out.replies[0]).toContain("You're one of the recipients");

  const stranger = click(client, guild, NOBODY, `claim:reject:${request.id}`);
  await handleClaimButton(stranger.interaction);
  expect(stranger.out.replies[0]).toContain("Only a minter, or the person who asked");

  const withdraw = click(client, guild, ALAIN, `claim:reject:${request.id}`);
  await handleClaimButton(withdraw.interaction);
  expect(withdraw.out.modal).toBeDefined();
  const submit = click(client, guild, ALAIN, `claim:rejectmodal:${request.id}`, "wrong amount");
  await handleClaimRejectModal(submit.interaction);
  expect(submit.out.updates[0]).toContain(`↩️ Withdrawn by <@${ALAIN}>: wrong amount`);
  const r = await getRequest(request.id, [GUILD]);
  expect(r?.status).toBe("cancelled");
  expect(r?.result).toEqual({ rejected: true, withdrawn: true, reason: "wrong amount" });
});

Deno.test("MCP propose_claim: schema and annotations", () => {
  const tool = getMcpTools().find((t) => t.name === "propose_claim")!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  const base = { guildId: "g", requesterUserId: "1", amount: 2, reason: "cleaning", requestedBy: "elinor" };
  expect(validateArguments(tool.inputSchema, base)).toBeNull();
  expect(validateArguments(tool.inputSchema, { ...base, amount: 11 })).toBe("Argument amount must be ≤ 10");
  expect(validateArguments(tool.inputSchema, { ...base, reason: "" })).toBe("Missing required string argument: reason");
  expect(tool.description).not.toContain("CHT");
});
