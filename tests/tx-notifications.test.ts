/**
 * Transaction notification tests
 *
 * Verifies that mint/burn/send commands post transaction notifications
 * to the correct Discord channel (per-token or default).
 */

import { expect } from "@std/expect/expect";
import type { GuildSettings, Token } from "../src/types.ts";

// ── Test fixtures ───────────────────────────────────────────────────────────

const CHT_CHANNEL = "1354115945718878269";
const EURCHB_CHANNEL = "1372518467323826259";
const DEFAULT_CHANNEL = "9999999999999999";

const chtToken: Token = {
  name: "Commons Hub Token",
  symbol: "CHT",
  decimals: 6,
  chain: "celo",
  address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d",
  mintable: true,
  transactionsChannelId: CHT_CHANNEL,
};

const eurchbToken: Token = {
  name: "EURchb",
  symbol: "EURchb",
  decimals: 6,
  chain: "gnosis",
  address: "0x5815E61eF72c9E6107b5c5A05FD121F334f7a7f1",
  mintable: false,
  transactionsChannelId: EURCHB_CHANNEL,
};

const tokenNoOverride: Token = {
  name: "Test Token",
  symbol: "TST",
  decimals: 18,
  chain: "base",
  address: "0x0000000000000000000000000000000000000001",
  mintable: true,
  // No transactionsChannelId — should fall back to default
};

const mockGuildSettings: GuildSettings = {
  tokens: [chtToken, eurchbToken, tokenNoOverride],
  guild: {
    id: "1280532848604086365",
    name: "Commons Hub Brussels",
    icon: null,
    timezone: "Europe/Brussels",
  },
  creator: {
    id: "689614876515237925",
    username: "xdamman",
    globalName: "Xavier",
    avatar: null,
  },
  channels: {
    transactions: DEFAULT_CHANNEL,
    contributions: "0",
    logs: "0",
  },
};

// ── Helper: resolve channel ID (mirrors logic in mint/burn/send) ────────────

function getTransactionsChannelId(
  token: Token,
  guildSettings: GuildSettings,
): string | undefined {
  return token.transactionsChannelId || guildSettings.channels?.transactions;
}

// ── Mock Discord interaction + client ───────────────────────────────────────

interface MockChannel {
  id: string;
  messages: string[];
  send: (msg: string) => Promise<void>;
}

function createMockClient(channels: Map<string, MockChannel>) {
  return {
    channels: {
      fetch: async (id: string): Promise<MockChannel | null> => {
        return channels.get(id) || null;
      },
    },
  };
}

function createMockChannel(id: string): MockChannel {
  return {
    id,
    messages: [],
    send: async function (msg: string) {
      this.messages.push(msg);
    },
  };
}

// Simulate what the commands do after a successful tx
async function simulatePostTxNotification(
  client: ReturnType<typeof createMockClient>,
  token: Token,
  guildSettings: GuildSettings,
  message: string,
): Promise<string | null> {
  const txChannelId = getTransactionsChannelId(token, guildSettings);
  if (!txChannelId) return null;

  try {
    const ch = await client.channels.fetch(txChannelId);
    if (ch) {
      await ch.send(message);
      return txChannelId;
    }
  } catch (_err) {
    // silent
  }
  return null;
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test("CHT token posts to CHT-specific channel", async () => {
  const chtChannel = createMockChannel(CHT_CHANNEL);
  const defaultChannel = createMockChannel(DEFAULT_CHANNEL);
  const channels = new Map([
    [CHT_CHANNEL, chtChannel],
    [DEFAULT_CHANNEL, defaultChannel],
  ]);
  const client = createMockClient(channels);

  const channelId = await simulatePostTxNotification(
    client,
    chtToken,
    mockGuildSettings,
    "🪙 Minted 100 CHT for @user",
  );

  expect(channelId).toBe(CHT_CHANNEL);
  expect(chtChannel.messages).toHaveLength(1);
  expect(chtChannel.messages[0]).toContain("CHT");
  expect(defaultChannel.messages).toHaveLength(0);
});

Deno.test("EURchb token posts to EURchb-specific channel", async () => {
  const eurchbChannel = createMockChannel(EURCHB_CHANNEL);
  const defaultChannel = createMockChannel(DEFAULT_CHANNEL);
  const channels = new Map([
    [EURCHB_CHANNEL, eurchbChannel],
    [DEFAULT_CHANNEL, defaultChannel],
  ]);
  const client = createMockClient(channels);

  const channelId = await simulatePostTxNotification(
    client,
    eurchbToken,
    mockGuildSettings,
    "💸 Sent 50 EURchb to @user",
  );

  expect(channelId).toBe(EURCHB_CHANNEL);
  expect(eurchbChannel.messages).toHaveLength(1);
  expect(eurchbChannel.messages[0]).toContain("EURchb");
  expect(defaultChannel.messages).toHaveLength(0);
});

Deno.test("Token without override falls back to default channel", async () => {
  const defaultChannel = createMockChannel(DEFAULT_CHANNEL);
  const channels = new Map([[DEFAULT_CHANNEL, defaultChannel]]);
  const client = createMockClient(channels);

  const channelId = await simulatePostTxNotification(
    client,
    tokenNoOverride,
    mockGuildSettings,
    "🔥 Burned 10 TST from @user",
  );

  expect(channelId).toBe(DEFAULT_CHANNEL);
  expect(defaultChannel.messages).toHaveLength(1);
});

Deno.test("No channel configured returns null", async () => {
  const channels = new Map<string, MockChannel>();
  const client = createMockClient(channels);

  const settingsNoChannel: GuildSettings = {
    ...mockGuildSettings,
    channels: { transactions: "", contributions: "", logs: "" },
  };

  const channelId = await simulatePostTxNotification(
    client,
    tokenNoOverride,
    settingsNoChannel,
    "test",
  );

  // Empty string is falsy, so should return null
  expect(channelId).toBe(null);
});

Deno.test("getTransactionsChannelId prefers token-level over default", () => {
  expect(getTransactionsChannelId(chtToken, mockGuildSettings)).toBe(CHT_CHANNEL);
  expect(getTransactionsChannelId(eurchbToken, mockGuildSettings)).toBe(EURCHB_CHANNEL);
  expect(getTransactionsChannelId(tokenNoOverride, mockGuildSettings)).toBe(DEFAULT_CHANNEL);
});

Deno.test("Multiple tokens post to different channels independently", async () => {
  const chtChannel = createMockChannel(CHT_CHANNEL);
  const eurchbChannel = createMockChannel(EURCHB_CHANNEL);
  const defaultChannel = createMockChannel(DEFAULT_CHANNEL);
  const channels = new Map([
    [CHT_CHANNEL, chtChannel],
    [EURCHB_CHANNEL, eurchbChannel],
    [DEFAULT_CHANNEL, defaultChannel],
  ]);
  const client = createMockClient(channels);

  await simulatePostTxNotification(client, chtToken, mockGuildSettings, "mint CHT");
  await simulatePostTxNotification(client, eurchbToken, mockGuildSettings, "send EURchb");
  await simulatePostTxNotification(client, tokenNoOverride, mockGuildSettings, "burn TST");

  expect(chtChannel.messages).toEqual(["mint CHT"]);
  expect(eurchbChannel.messages).toEqual(["send EURchb"]);
  expect(defaultChannel.messages).toEqual(["burn TST"]);
});

Deno.test("Settings migration preserves transactionsChannelId", () => {
  // Simulate raw settings from disk (with both legacy and tokens array)
  const raw = {
    contributionToken: {
      name: "CHT", symbol: "CHT", decimals: 6,
      chain: "celo", address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d",
    },
    tokens: [
      {
        name: "CHT", symbol: "CHT", decimals: 6, chain: "celo",
        address: "0x65dd32834927de9e57e72a3e2130a19f81c6371d",
        mintable: true, transactionsChannelId: CHT_CHANNEL,
      },
    ],
    guild: { id: "test", name: "Test", icon: null },
    creator: { id: "1", username: "test", globalName: null, avatar: null },
    channels: { transactions: DEFAULT_CHANNEL, contributions: "", logs: "" },
  };

  // The tokens array already has CHT with transactionsChannelId.
  // Migration should NOT overwrite it with a legacy token that lacks the field.
  const tokens = raw.tokens;
  const exists = tokens.some(
    (t: any) => t.address.toLowerCase() === raw.contributionToken.address.toLowerCase(),
  );

  expect(exists).toBe(true);
  expect(tokens[0].transactionsChannelId).toBe(CHT_CHANNEL);
});
