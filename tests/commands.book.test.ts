import { expect } from "@std/expect/expect";
import { stub } from "@std/testing/mock";
import { handleBookCommand } from "../src/commands/book.ts";
import * as utils from "../src/lib/utils.ts";
import * as blockchain from "../src/lib/blockchain.ts";
import * as citizenwallet from "../src/lib/citizenwallet.ts";
import { parseUnits } from "@wevm/viem";

// Mock interaction
const createMockInteraction = () => {
  const interaction = {
    isChatInputCommand: () => true,
    options: {
      getString: (key: string) => {
        const values: Record<string, string> = {
          room: "meeting-room",
          when: "tomorrow 2pm",
          duration: "30m",
          name: "Test Meeting",
        };
        return values[key] || null;
      },
    },
    user: {
      id: "test-user-123",
      displayName: "Test User",
      username: "testuser",
    },
    reply: stub(() => Promise.resolve()),
  };
  return interaction;
};

// Mock guild settings
const mockGuildSettings = {
  contributionToken: {
    name: "Community Hour Token",
    symbol: "CHT",
    decimals: 6,
    chain: "celo" as const,
    address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
    mintInstructions: "Visit the faucet to get more tokens",
  },
  guild: {
    id: "1280532848604086365",
    name: "Test Guild",
    icon: null,
  },
  creator: {
    id: "creator-id",
    username: "creator",
    globalName: "Creator",
    avatar: null,
  },
  channels: {
    transactions: "tx-channel-id",
    contributions: "contrib-channel-id",
    logs: "logs-channel-id",
  },
};

// Mock products
const mockProducts = [
  {
    type: "room" as const,
    unit: "hour" as const,
    slug: "meeting-room",
    name: "Meeting Room",
    availabilities: "Mon-Fri 9am-5pm",
    calendarId: "calendar-id-123",
    price: [
      { token: "CHT", amount: 10 },
      { token: "EURb", amount: 5 },
    ],
  },
];

Deno.test("Book command confirmation message - 30 minutes duration", async () => {
  const interaction = createMockInteraction();

  // Mock all dependencies
  const loadGuildFileStub = stub(utils, "loadGuildFile", () => Promise.resolve(mockProducts));
  const loadGuildSettingsStub = stub(utils, "loadGuildSettings", () =>
    Promise.resolve(mockGuildSettings));
  const getAddressStub = stub(
    citizenwallet,
    "getAccountAddressFromDiscordUserId",
    () => Promise.resolve("0xUserAddress" as `0x${string}`),
  );
  const getBalanceStub = stub(blockchain, "getBalance", () =>
    Promise.resolve(parseUnits("100", 6))); // 100 tokens

  try {
    // Update duration to 30m
    interaction.options.getString = (key: string) => {
      const values: Record<string, string> = {
        room: "meeting-room",
        when: "tomorrow 2pm",
        duration: "30m",
        name: "Test Meeting",
      };
      return values[key] || null;
    };

    await handleBookCommand(interaction as any, "test-user-123", "1280532848604086365");

    // Get the reply content
    const replyCall = (interaction.reply as any).calls[0];
    const content = replyCall.args[0].content;

    // Verify the content
    expect(content).toContain("**Booking Summary**");
    expect(content).toContain("**Event:**    Test Meeting");
    expect(content).toContain("**Room:**     Meeting Room");
    expect(content).toContain("**Duration:** 30 minutes (0.5h)");

    // Check price formatting (30 minutes = 0.5 hours)
    // CHT: 10 * 0.5 = 5.00, EURb: 5 * 0.5 = 2.50
    expect(content).toContain("**Price:**    5.00 CHT or 2.50 EURb");

    // Check balance
    expect(content).toContain("**Balance:**  100.00 CHT");

    // Should not have insufficient balance warning
    expect(content).not.toContain("Insufficient balance");
  } finally {
    loadGuildFileStub.restore();
    loadGuildSettingsStub.restore();
    getAddressStub.restore();
    getBalanceStub.restore();
  }
});

Deno.test("Book command confirmation message - 120 minutes duration", async () => {
  const interaction = createMockInteraction();

  const loadGuildFileStub = stub(utils, "loadGuildFile", () => Promise.resolve(mockProducts));
  const loadGuildSettingsStub = stub(utils, "loadGuildSettings", () =>
    Promise.resolve(mockGuildSettings));
  const getAddressStub = stub(
    citizenwallet,
    "getAccountAddressFromDiscordUserId",
    () => Promise.resolve("0xUserAddress" as `0x${string}`),
  );
  const getBalanceStub = stub(blockchain, "getBalance", () =>
    Promise.resolve(parseUnits("100", 6)));

  try {
    // Update duration to 120m
    interaction.options.getString = (key: string) => {
      const values: Record<string, string> = {
        room: "meeting-room",
        when: "tomorrow 2pm",
        duration: "120m",
        name: "Test Meeting",
      };
      return values[key] || null;
    };

    await handleBookCommand(interaction as any, "test-user-123", "1280532848604086365");

    const replyCall = (interaction.reply as any).calls[0];
    const content = replyCall.args[0].content;

    expect(content).toContain("**Duration:** 120 minutes (2.0h)");

    // Check price formatting (120 minutes = 2 hours)
    // CHT: 10 * 2 = 20.00, EURb: 5 * 2 = 10.00
    expect(content).toContain("**Price:**    20.00 CHT or 10.00 EURb");
    expect(content).toContain("**Balance:**  100.00 CHT");
  } finally {
    loadGuildFileStub.restore();
    loadGuildSettingsStub.restore();
    getAddressStub.restore();
    getBalanceStub.restore();
  }
});

Deno.test("Book command confirmation message - 150 minutes duration", async () => {
  const interaction = createMockInteraction();

  const loadGuildFileStub = stub(utils, "loadGuildFile", () => Promise.resolve(mockProducts));
  const loadGuildSettingsStub = stub(utils, "loadGuildSettings", () =>
    Promise.resolve(mockGuildSettings));
  const getAddressStub = stub(
    citizenwallet,
    "getAccountAddressFromDiscordUserId",
    () => Promise.resolve("0xUserAddress" as `0x${string}`),
  );
  const getBalanceStub = stub(blockchain, "getBalance", () =>
    Promise.resolve(parseUnits("100", 6)));

  try {
    // Update duration to 150m
    interaction.options.getString = (key: string) => {
      const values: Record<string, string> = {
        room: "meeting-room",
        when: "tomorrow 2pm",
        duration: "150m",
        name: "Test Meeting",
      };
      return values[key] || null;
    };

    await handleBookCommand(interaction as any, "test-user-123", "1280532848604086365");

    const replyCall = (interaction.reply as any).calls[0];
    const content = replyCall.args[0].content;

    expect(content).toContain("**Duration:** 150 minutes (2.5h)");

    // Check price formatting (150 minutes = 2.5 hours)
    // CHT: 10 * 2.5 = 25.00, EURb: 5 * 2.5 = 12.50
    expect(content).toContain("**Price:**    25.00 CHT or 12.50 EURb");
    expect(content).toContain("**Balance:**  100.00 CHT");
  } finally {
    loadGuildFileStub.restore();
    loadGuildSettingsStub.restore();
    getAddressStub.restore();
    getBalanceStub.restore();
  }
});

Deno.test("Book command confirmation message - insufficient balance", async () => {
  const interaction = createMockInteraction();

  const loadGuildFileStub = stub(utils, "loadGuildFile", () => Promise.resolve(mockProducts));
  const loadGuildSettingsStub = stub(utils, "loadGuildSettings", () =>
    Promise.resolve(mockGuildSettings));
  const getAddressStub = stub(
    citizenwallet,
    "getAccountAddressFromDiscordUserId",
    () => Promise.resolve("0xUserAddress" as `0x${string}`),
  );
  const getBalanceStub = stub(blockchain, "getBalance", () =>
    Promise.resolve(parseUnits("3", 6))); // Only 3 tokens

  try {
    // 30 minutes requires 5 CHT
    interaction.options.getString = (key: string) => {
      const values: Record<string, string> = {
        room: "meeting-room",
        when: "tomorrow 2pm",
        duration: "30m",
        name: "Test Meeting",
      };
      return values[key] || null;
    };

    await handleBookCommand(interaction as any, "test-user-123", "1280532848604086365");

    const replyCall = (interaction.reply as any).calls[0];
    const content = replyCall.args[0].content;

    // Should show insufficient balance warning
    expect(content).toContain("⚠️ **Insufficient balance**");
    expect(content).toContain("You need 5.00 CHT but only have 3.00 CHT");
    expect(content).toContain("Visit the faucet to get more tokens");

    // Check that button is disabled
    const components = replyCall.args[0].components;
    expect(components).toBeDefined();
    const button = components[0].components[0];
    expect(button.data.disabled).toBe(true);
  } finally {
    loadGuildFileStub.restore();
    loadGuildSettingsStub.restore();
    getAddressStub.restore();
    getBalanceStub.restore();
  }
});

Deno.test("Book command - verify all amounts have max 2 decimal places", async () => {
  const interaction = createMockInteraction();

  const loadGuildFileStub = stub(utils, "loadGuildFile", () => Promise.resolve(mockProducts));
  const loadGuildSettingsStub = stub(utils, "loadGuildSettings", () =>
    Promise.resolve(mockGuildSettings));
  const getAddressStub = stub(
    citizenwallet,
    "getAccountAddressFromDiscordUserId",
    () => Promise.resolve("0xUserAddress" as `0x${string}`),
  );
  const getBalanceStub = stub(blockchain, "getBalance", () =>
    Promise.resolve(parseUnits("123.456789", 6)));

  try {
    // 45 minutes should result in 0.75 hours
    interaction.options.getString = (key: string) => {
      const values: Record<string, string> = {
        room: "meeting-room",
        when: "tomorrow 2pm",
        duration: "45m",
        name: "Test Meeting",
      };
      return values[key] || null;
    };

    await handleBookCommand(interaction as any, "test-user-123", "1280532848604086365");

    const replyCall = (interaction.reply as any).calls[0];
    const content = replyCall.args[0].content;

    // Check that all numbers have max 2 decimal places
    // Price: 10 * 0.75 = 7.50 CHT, 5 * 0.75 = 3.75 EURb
    expect(content).toContain("7.50 CHT");
    expect(content).toContain("3.75 EURb");

    // Balance should be formatted to 2 decimal places
    expect(content).toContain("123.46 CHT"); // or 123.45 depending on rounding

    // Verify no numbers have more than 2 decimal places
    const numberRegex = /\d+\.\d{3,}/;
    expect(numberRegex.test(content)).toBe(false);
  } finally {
    loadGuildFileStub.restore();
    loadGuildSettingsStub.restore();
    getAddressStub.restore();
    getBalanceStub.restore();
  }
});
