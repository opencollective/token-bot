/**
 * Tests for the shared mint helpers and the emoji reaction resolution used by the
 * "Mint tokens" context menu and the :mint: / :coin: reaction flows.
 */
import { expect } from "@std/expect/expect";
import { buildMessageUrl, recipientsFromMessage, tokenTag } from "../src/lib/mint.ts";
import {
  parseEmojiConfig,
  requiredMintEmojiNames,
  resolveReactionAction,
} from "../src/lib/reactions.ts";
import type { GuildSettings, Token } from "../src/types.ts";

const CHT: Token = {
  name: "Commons Hub Token",
  symbol: "CHT",
  decimals: 6,
  chain: "celo",
  address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d",
  mintable: true,
  walletManager: "citizenwallet",
  minterRoleId: "role-cht",
};

const EUR: Token = {
  name: "EURchb",
  symbol: "EURchb",
  decimals: 6,
  chain: "gnosis",
  address: "0x9ee438a16be3c75247aded9c80e801bf4764ca5c",
  mintable: true,
};

const NOT_MINTABLE: Token = { ...EUR, symbol: "X", mintable: false };

function msg(authorId: string, mentionIds: string[], opts: { authorBot?: boolean; botIds?: string[] } = {}) {
  const bots = new Set(opts.botIds ?? []);
  const users = new Map(mentionIds.map((id) => [id, { id, bot: bots.has(id) }]));
  return { author: { id: authorId, bot: opts.authorBot }, mentions: { users } };
}

Deno.test("recipientsFromMessage: author first, then mentions, deduped", () => {
  const recipients = recipientsFromMessage(msg("author", ["alain", "marlene", "author", "doug"]));
  expect(recipients.map((r) => r.id)).toEqual(["author", "alain", "marlene", "doug"]);
  expect(recipients[0]).toEqual({
    type: "discord",
    id: "author",
    label: "<@author>",
    accountId: "discord:author",
  });
});

Deno.test("recipientsFromMessage: skips bots and excluded users", () => {
  const recipients = recipientsFromMessage(
    msg("author", ["alain", "bot1", "steward"], { botIds: ["bot1"] }),
    { excludeUserIds: ["steward"] },
  );
  expect(recipients.map((r) => r.id)).toEqual(["author", "alain"]);
});

Deno.test("recipientsFromMessage: bot author with no mentions yields nothing", () => {
  expect(recipientsFromMessage(msg("bot", [], { authorBot: true }))).toEqual([]);
  expect(recipientsFromMessage({ author: null, mentions: { users: new Map() } })).toEqual([]);
});

Deno.test("buildMessageUrl and tokenTag", () => {
  expect(buildMessageUrl("g", "c", "m")).toBe("https://discord.com/channels/g/c/m");
  expect(tokenTag(CHT)).toBe("ethereum:42220:address:0x65dd32834927de9e57e72a3e2130a19f81c6371d");
});

Deno.test("parseEmojiConfig handles name, :name:, unicode, id and <:name:id>", () => {
  expect(parseEmojiConfig("mint")).toEqual({ name: "mint" });
  expect(parseEmojiConfig(":mint:")).toEqual({ name: "mint" });
  expect(parseEmojiConfig("🪙")).toEqual({ name: "🪙" });
  expect(parseEmojiConfig("123456")).toEqual({ id: "123456" });
  expect(parseEmojiConfig("<:mint:123456>")).toEqual({ name: "mint", id: "123456" });
  expect(parseEmojiConfig("<a:mint:123456>")).toEqual({ name: "mint", id: "123456" });
});

Deno.test("resolveReactionAction: defaults map :mint: and 🪙 to the first mintable token", () => {
  const tokens = [NOT_MINTABLE, CHT, EUR];
  expect(resolveReactionAction(tokens, { name: "mint", id: "1" })).toEqual({ kind: "mint", token: CHT });
  expect(resolveReactionAction(tokens, { name: "🪙", id: null })).toEqual({ kind: "send", token: CHT });
  expect(resolveReactionAction(tokens, { name: "👍", id: null })).toBeNull();
  expect(resolveReactionAction([NOT_MINTABLE], { name: "mint", id: "1" })).toBeNull();
});

Deno.test("resolveReactionAction: explicit config wins and disables the default for that kind", () => {
  const tokens = [CHT, { ...EUR, mintEmoji: "minteur" }];
  expect(resolveReactionAction(tokens, { name: "minteur", id: "9" })?.token.symbol).toBe("EURchb");
  // A token configured mintEmoji → ":mint:" no longer falls back to CHT
  expect(resolveReactionAction(tokens, { name: "mint", id: "1" })).toBeNull();
  // …but the send default is untouched
  expect(resolveReactionAction(tokens, { name: "🪙", id: null })).toEqual({ kind: "send", token: CHT });

  const byId = [{ ...CHT, mintEmoji: "<:mint:42>", sendEmoji: "💰" }];
  expect(resolveReactionAction(byId, { name: "renamed", id: "42" })?.kind).toBe("mint");
  expect(resolveReactionAction(byId, { name: "mint", id: "43" })).toBeNull();
  expect(resolveReactionAction(byId, { name: "💰", id: null })?.kind).toBe("send");
  expect(resolveReactionAction(byId, { name: "🪙", id: null })).toBeNull();
});

Deno.test("requiredMintEmojiNames", () => {
  const base = {
    guild: { id: "g", name: "G", icon: null },
    creator: { id: "u", username: "u", globalName: null, avatar: null },
    channels: { transactions: "", contributions: "", logs: "" },
  };
  expect(requiredMintEmojiNames({ ...base, tokens: [] } as GuildSettings)).toEqual([]);
  expect(requiredMintEmojiNames({ ...base, tokens: [CHT, EUR] } as GuildSettings)).toEqual(["mint"]);
  expect(
    requiredMintEmojiNames(
      { ...base, tokens: [{ ...CHT, mintEmoji: "mint" }, { ...EUR, mintEmoji: "<:x:1>" }] } as GuildSettings,
    ),
  ).toEqual(["mint"]);
});
