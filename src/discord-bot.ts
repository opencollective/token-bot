// deno run --allow-net --allow-env --allow-read --allow-write src/discord-bot.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  MessageFlags,
  ModalBuilder,
  REST,
  RoleSelectMenuBuilder,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import commands from "./commands.json" with { type: "json" };
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from "@wevm/viem";
import { base, celo, gnosis, polygon } from "@wevm/viem/chains";
import { privateKeyToAccount } from "@wevm/viem/accounts";
import {
  loadGuildFile,
  loadGuildSettings,
  loadRoles,
  saveGuildSettings,
  saveRoles,
} from "./lib/utils.ts";

import type {
  BlockchainAddress,
  Chain,
  ChannelSetupState,
  CostEditState,
  GuildSettings,
  Product,
  RewardEditState,
  RoleSetting,
  TokenSetupState,
} from "./types.ts";
import { deployTokenContract } from "./lib/blockchain.ts";

const BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN")!;
const CLIENT_ID = Deno.env.get("DISCORD_CLIENT_ID")!;
// Set a GUILD_ID to test the bot in a specific server
// const GUILD_ID = "1418496180643696782"; // open source village discord server
const GUILD_ID = Deno.env.get("DISCORD_GUILD_ID")!;

const PRIVATE_KEY = Deno.env.get("PRIVATE_KEY") as `0x${string}`;
const CHAIN = Deno.env.get("CHAIN") as SupportedChain || "base_sepolia";

const tokenSetupStates = new Map<string, TokenSetupState>();
const channelSetupStates = new Map<string, ChannelSetupState>();
const rewardEditStates = new Map<string, RewardEditState>();
const costEditStates = new Map<string, CostEditState>();

import { getNativeBalance, getTokenHolderCount, getTotalSupply, getWalletClient, hasRole, MINTER_ROLE, SupportedChain } from "./lib/blockchain.ts";
import handleMintCommand, { handleMintButton, handleMintModal, handleMintSelect } from "./commands/mint.ts";
import handleSendCommand from "./commands/send.ts";
import handleBalanceCommand from "./commands/balance.ts";
import { handleBookButton, handleBookCommand, handleBookModal, handleBookSelect } from "./commands/book.ts";
import { handleCancelButton, handleCancelCommand, handleCancelSelect } from "./commands/cancel.ts";
import { GoogleCalendarClient } from "./lib/googlecalendar.ts";

// Display server startup time and timezone
const now = new Date();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateTimeStr = now.toLocaleString('en-GB', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: timezone
});
console.log(`🚀 Server starting at ${dateTimeStr} (${timezone})`);

const botWallet = getWalletClient(CHAIN);
const nativeBalance = await getNativeBalance(CHAIN, botWallet.account?.address as string);
console.log(">>> botWallet address", botWallet.account?.address, "on", CHAIN);
console.log(">>> nativeBalance", formatUnits(nativeBalance, 18));

if (nativeBalance < BigInt(0.001 * 10 ** 18)) {
  console.error("❌ Bot wallet has less than 0.001 ETH");
  Deno.exit(1);
}

// Check Google Calendar credentials
let calendarEnabled = false;
try {
  const keyFilePath = Deno.env.get("GOOGLE_ACCOUNT_KEY_FILEPATH") || "./google-account-key.json";
  await Deno.stat(keyFilePath);

  // Try to instantiate the client to verify credentials are valid
  const testClient = new GoogleCalendarClient();
  calendarEnabled = true;
  console.log("✅ Google Calendar credentials found and loaded");
} catch (error) {
  console.warn("⚠️  Google Calendar credentials not found or invalid");
  console.warn("⚠️  /book and /cancel commands will be disabled");
  console.warn(`⚠️  Set GOOGLE_ACCOUNT_KEY_FILEPATH or place credentials at ./google-account-key.json`);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

// Chain config
const baseSepoliaChain = {
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia.base.org"] },
    public: { http: ["https://sepolia.base.org"] },
  },
  blockExplorers: { default: { name: "BaseScan", url: "https://sepolia.basescan.org" } },
  testnet: true,
};

const chainConfig = {
  celo: { chain: celo, rpc: "https://forno.celo.org" },
  gnosis: { chain: gnosis, rpc: "https://rpc.gnosischain.com" },
  base: { chain: base, rpc: "https://mainnet.base.org" },
  base_sepolia: { chain: baseSepoliaChain, rpc: "https://sepolia.base.org" },
  polygon: { chain: polygon, rpc: "https://polygon-rpc.com" },
};

// Blockchain helpers
async function fetchTokenInfo(chain: Chain, address: BlockchainAddress) {
  const config = chainConfig[chain];
  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpc),
  });

  const [name, symbol, decimals] = await Promise.all([
    publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "name",
    }),
    publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);

  return { name, symbol, decimals };
}

// Command registration
async function registerCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

    console.log("🔄 Registering application (/) commands...");

    // Filter out calendar commands if credentials are not available
    let commandsToRegister = commands;
    if (!calendarEnabled) {
      commandsToRegister = commands.filter(cmd => cmd.name !== "book" && cmd.name !== "cancel");
      console.log("⚠️  Skipping registration of /book and /cancel commands (no calendar credentials)");
    }

    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandsToRegister });
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandsToRegister });
    }

    console.log("✅ Successfully registered application (/) commands.");
  } catch (error) {
    console.error("❌ Failed to register commands:", error);
  }
}

// Event handlers
client.on(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Discord bot logged in as ${readyClient.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    if (!guildId) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "This bot only works in servers, not DMs.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "list-tokens") {
        return handleListTokensCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "add-token") {
        return handleAddTokenCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "setup-channels") {
        return handleSetupChannelsCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "mint") {
        return handleMintCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "send") {
        return handleSendCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "balance") {
        return handleBalanceCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "edit-rewards") {
        return handleEditRewardsCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "edit-costs") {
        return handleEditCostsCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "book") {
        if (!calendarEnabled) {
          await interaction.reply({
            content: "⚠️ Calendar features are disabled. Google Calendar credentials not found.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        return handleBookCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "cancel") {
        if (!calendarEnabled) {
          await interaction.reply({
            content: "⚠️ Calendar features are disabled. Google Calendar credentials not found.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        return handleCancelCommand(interaction, userId, guildId);
      }
    }

    // Handle component interactions
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("book_")) {
        return handleBookButton(interaction, userId, guildId);
      }
      if (interaction.customId.startsWith("mint_")) {
        return handleMintButton(interaction, userId);
      }
      if (
        interaction.customId.startsWith("cancel_confirm_") ||
        interaction.customId === "cancel_abort"
      ) {
        return handleCancelButton(interaction, userId);
      }
      return handleButton(interaction, userId, guildId);
    }
    if (interaction.isChannelSelectMenu()) {
      return handleChannelSelect(interaction, userId, guildId);
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "cancel_select_event") {
        return handleCancelSelect(interaction, userId);
      }
      if (interaction.customId === "book_date_select" || interaction.customId === "book_time_select") {
        return handleBookSelect(interaction, userId, guildId);
      }
      if (interaction.customId === "mint_token_select") {
        return handleMintSelect(interaction, userId, guildId);
      }
      return handleStringSelect(interaction, userId, guildId);
    }
    if (interaction.isRoleSelectMenu()) {
      return handleRoleSelect(interaction, userId, guildId);
    }
  } catch (error) {
    console.error("Error handling interaction:", error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "An error occurred while processing your request.",
        flags: MessageFlags.Ephemeral,
      }).catch(console.error);
    }
  }
});

// Token info with supply and holders
interface TokenStats {
  totalSupply: string;
  holders: number | null;
}

// Helper to get block explorer URL for a token
function getExplorerUrl(chain: Chain, address: string): string {
  const explorers: Record<Chain, string> = {
    celo: "https://celoscan.io/token",
    gnosis: "https://gnosisscan.io/token",
    base: "https://basescan.org/token",
    base_sepolia: "https://sepolia.basescan.org/token",
    polygon: "https://polygonscan.com/token",
  };
  return `${explorers[chain]}/${address}`;
}

// Fetch token stats (supply and holders)
async function fetchTokenStats(chain: Chain, address: string, decimals: number): Promise<TokenStats> {
  try {
    const [totalSupplyRaw, holders] = await Promise.all([
      getTotalSupply(chain as SupportedChain, address),
      getTokenHolderCount(chain as SupportedChain, address),
    ]);
    
    const totalSupply = formatUnits(totalSupplyRaw, decimals);
    // Format with thousand separators, no decimals
    const formattedSupply = Math.floor(parseFloat(totalSupply)).toLocaleString('en-US');
    
    return { totalSupply: formattedSupply, holders };
  } catch (error) {
    console.error(`Error fetching token stats for ${address}:`, error);
    return { totalSupply: "?", holders: null };
  }
}

// Helper function to format token list
async function formatTokenList(settings: GuildSettings | null): Promise<string> {
  if (!settings) {
    return "No tokens configured yet.";
  }

  const tokens: string[] = [];

  // Contribution token
  if (settings.contributionToken?.address) {
    const ct = settings.contributionToken;
    const explorerUrl = getExplorerUrl(ct.chain, ct.address);
    const stats = await fetchTokenStats(ct.chain, ct.address, ct.decimals);
    
    const shortAddr = `${ct.address.slice(0, 6)}…${ct.address.slice(-4)}`;
    let tokenInfo = `**${ct.name} (${ct.symbol})**\n`;
    tokenInfo += `• Address: [${ct.chain}:${shortAddr}](<${explorerUrl}>)\n`;
    tokenInfo += `• Supply: ${stats.totalSupply} ${ct.symbol}`;
    if (stats.holders !== null) {
      tokenInfo += ` · ${stats.holders.toLocaleString('en-US')} holders`;
    }
    
    tokens.push(tokenInfo);
  }

  // Fiat token (if configured)
  const fiatToken = (settings as any).fiatToken;
  if (fiatToken?.address) {
    const explorerUrl = getExplorerUrl(fiatToken.chain, fiatToken.address);
    const stats = await fetchTokenStats(fiatToken.chain, fiatToken.address, fiatToken.decimals);
    
    const shortAddr = `${fiatToken.address.slice(0, 6)}…${fiatToken.address.slice(-4)}`;
    let tokenInfo = `**${fiatToken.name} (${fiatToken.symbol})**\n`;
    tokenInfo += `• Address: [${fiatToken.chain}:${shortAddr}](<${explorerUrl}>)\n`;
    tokenInfo += `• Supply: ${stats.totalSupply} ${fiatToken.symbol}`;
    if (stats.holders !== null) {
      tokenInfo += ` · ${stats.holders.toLocaleString('en-US')} holders`;
    }
    
    tokens.push(tokenInfo);
  }

  // Additional tokens from tokens array
  const additionalTokens = (settings as any).tokens || [];
  for (const token of additionalTokens) {
    if (token?.address) {
      const explorerUrl = getExplorerUrl(token.chain, token.address);
      const stats = await fetchTokenStats(token.chain, token.address, token.decimals);
      
      const shortAddr = `${token.address.slice(0, 6)}…${token.address.slice(-4)}`;
      let tokenInfo = `**${token.name} (${token.symbol})**\n`;
      tokenInfo += `• Address: [${token.chain}:${shortAddr}](<${explorerUrl}>)\n`;
      tokenInfo += `• Supply: ${stats.totalSupply} ${token.symbol}`;
      if (stats.holders !== null) {
        tokenInfo += ` · ${stats.holders.toLocaleString('en-US')} holders`;
      }
      
      tokens.push(tokenInfo);
    }
  }

  if (tokens.length === 0) {
    return "No tokens configured yet.";
  }

  return tokens.join("\n\n");
}

// Command handlers
async function handleListTokensCommand(
  interaction: Interaction,
  _userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const settings = await loadGuildSettings(guildId);
  const tokenList = await formatTokenList(settings);

  await interaction.editReply({
    content: `**🪙 Configured Tokens**\n\n${tokenList}`,
  });
}

async function handleAddTokenCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Show existing tokens first
  const settings = await loadGuildSettings(guildId);
  const tokenList = await formatTokenList(settings);
  const hasTokens = settings?.contributionToken?.address || (settings as any)?.fiatToken?.address;

  tokenSetupStates.set(userId, { step: "choice" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("token_create_new")
      .setLabel("Create New Token")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("token_use_existing")
      .setLabel("Use Existing Token")
      .setStyle(ButtonStyle.Secondary),
  );

  const header = hasTokens 
    ? `**🪙 Current Tokens**\n\n${tokenList}\n\n---\n\n**Add/Update Token**\n\nWould you like to create a new token or use an existing one?`
    : "**🪙 Token Setup**\n\nNo tokens configured yet.\n\nWould you like to create a new token or use an existing one?";

  await interaction.editReply({
    content: header,
    components: [row],
  });
}

async function handleSetupChannelsCommand(
  interaction: Interaction,
  userId: string,
  _guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  channelSetupStates.set(userId, {});

  const row1 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("channel_transactions")
      .setPlaceholder("Select #transactions channel")
      .setChannelTypes(ChannelType.GuildText),
  );

  const row2 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("channel_contributions")
      .setPlaceholder("Select #contributions channel")
      .setChannelTypes(ChannelType.GuildText),
  );

  const row3 = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("channel_logs")
      .setPlaceholder("Select #logs channel")
      .setChannelTypes(ChannelType.GuildText),
  );

  await interaction.reply({
    content: "**📢 Channel Setup**\n\nSelect the channels for the bot:",
    components: [row1, row2, row3],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleEditRewardsCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  const settings = await loadGuildSettings(guildId);
  if (!settings) {
    await interaction.reply({
      content: "⚠️ Please run `/setup-token` and `/setup-channels` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get parameters from command options
  const roleId = interaction.options.getRole("role")?.id;
  const amount = interaction.options.getInteger("amount");
  const frequency = interaction.options.getString("frequency") as "daily" | "weekly" | "monthly";

  if (!roleId || !amount || !frequency) {
    await interaction.reply({
      content: "⚠️ Missing required parameters.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Load existing roles configuration
  let roles: RoleSetting[] = [];
  try {
    const rolesContent = await Deno.readTextFile(`./data/${guildId}/roles.json`);
    roles = JSON.parse(rolesContent);
  } catch {
    // No roles file yet, start fresh
  }

  // Find or create role setting
  let roleSetting = roles.find((r) => r.id === roleId);
  if (!roleSetting) {
    roleSetting = {
      id: roleId,
      name: "",
      amountToMint: amount,
      amountToBurn: 0,
      frequency,
      rolesToPingIfEmpty: [],
      onlyToActiveContributors: false,
    };
    roles.push(roleSetting);
  } else {
    roleSetting.amountToMint = amount;
    roleSetting.frequency = frequency;
  }

  // Save immediately
  await saveRoles(guildId, roles);

  // Store state for optional settings updates
  rewardEditStates.set(userId, {
    id: roleId,
    amountToMint: amount,
    frequency,
    rolesToPingIfEmpty: roleSetting.rolesToPingIfEmpty,
    onlyToActiveContributors: roleSetting.onlyToActiveContributors,
  });

  await interaction.reply({
    content: `✅ **Reward settings saved!**

<@&${roleId}> will receive **${amount} tokens ${frequency}**

You can optionally configure:`,
    components: getRewardEditComponents(),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleEditCostsCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  const settings = await loadGuildSettings(guildId);
  if (!settings) {
    await interaction.reply({
      content: "⚠️ Please run `/setup-token` and `/setup-channels` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get parameters from command options
  const roleId = interaction.options.getRole("role")?.id;
  const amount = interaction.options.getInteger("amount");
  const frequency = interaction.options.getString("frequency") as "daily" | "weekly" | "monthly";

  if (!roleId || !amount || !frequency) {
    await interaction.reply({
      content: "⚠️ Missing required parameters.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Load existing roles configuration
  let roles: RoleSetting[] = [];
  try {
    const rolesContent = await Deno.readTextFile(`./data/${guildId}/roles.json`);
    roles = JSON.parse(rolesContent);
  } catch {
    // No roles file yet, start fresh
  }

  // Find or create role setting
  let roleSetting = roles.find((r) => r.id === roleId);
  if (!roleSetting) {
    roleSetting = {
      id: roleId,
      name: "",
      amountToMint: 0,
      amountToBurn: amount,
      frequency,
      rolesToPingIfEmpty: [],
      onlyToActiveContributors: false,
    };
    roles.push(roleSetting);
  } else {
    roleSetting.amountToBurn = amount;
    roleSetting.frequency = frequency;
  }

  // Save immediately
  await saveRoles(guildId, roles);

  // Store state for optional settings updates
  costEditStates.set(userId, {
    id: roleId,
    amountToBurn: amount,
    frequency,
    rolesToPingIfEmpty: roleSetting.rolesToPingIfEmpty,
    onlyToActiveContributors: roleSetting.onlyToActiveContributors,
  });

  await interaction.reply({
    content: `✅ **Cost settings saved!**

<@&${roleId}> will burn **${amount} tokens ${frequency}**

You can optionally configure:`,
    components: getCostEditComponents(),
    flags: MessageFlags.Ephemeral,
  });
}

// Component handlers
async function handleButton(
  interaction: Interaction,
  userId: string,
  _guildId: string,
) {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;

  // Token setup buttons
  if (customId === "token_create_new") {
    const state = tokenSetupStates.get(userId);
    if (!state) return;

    await interaction.deferUpdate();

    // Check deployer balance on Gnosis
    const deployerAddress = botWallet.account?.address as string;
    const balance = await getNativeBalance("gnosis", deployerAddress);
    const balanceFormatted = parseFloat(formatUnits(balance, 18)).toFixed(4);
    const explorerUrl = `https://gnosisscan.io/address/${deployerAddress}`;
    const shortAddr = `${deployerAddress.slice(0, 6)}…${deployerAddress.slice(-4)}`;

    const MIN_DEPLOY_BALANCE = 0.001;
    const hasEnoughBalance = parseFloat(balanceFormatted) >= MIN_DEPLOY_BALANCE;

    if (!hasEnoughBalance) {
      await interaction.editReply({
        content: `**🪙 Create New Token**\n\n` +
          `**Deployer:** [gnosis:${shortAddr}](<${explorerUrl}>)\n` +
          `**Balance:** ${balanceFormatted} XDAI\n\n` +
          `⚠️ **Insufficient balance**\n` +
          `You need at least ${MIN_DEPLOY_BALANCE} XDAI to deploy a token.\n\n` +
          `Please send some XDAI to the deployer address and try again.`,
        components: [],
      });
      return;
    }

    // Balance is sufficient, show the modal button
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("token_show_create_modal")
        .setLabel("Continue")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("token_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.editReply({
      content: `**🪙 Create New Token**\n\n` +
        `**Chain:** Gnosis\n` +
        `**Deployer:** [gnosis:${shortAddr}](<${explorerUrl}>)\n` +
        `**Balance:** ${balanceFormatted} XDAI ✅\n\n` +
        `Click Continue to enter your token details.`,
      components: [row],
    });
    return;
  }

  // Show create token modal (after balance check)
  if (customId === "token_show_create_modal") {
    const state = tokenSetupStates.get(userId);
    if (!state) return;

    const guildName = interaction.guild?.name || "Server";
    const defaultSymbol = guildName.split(" ").map((w) =>
      w.substring(0, 1).toUpperCase()
    ).join("") + "T";

    const modal = new ModalBuilder()
      .setCustomId("token_create_modal")
      .setTitle("Create New Token")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("token_name")
            .setLabel("Token Name")
            .setStyle(TextInputStyle.Short)
            .setValue(`${guildName} Token`)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("token_symbol")
            .setLabel("Token Symbol")
            .setStyle(TextInputStyle.Short)
            .setValue(defaultSymbol)
            .setRequired(true),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  // Cancel token setup
  if (customId === "token_cancel") {
    tokenSetupStates.delete(userId);
    await interaction.update({
      content: "Token setup cancelled.",
      components: [],
    });
    return;
  }

  if (customId === "token_use_existing") {
    const state = tokenSetupStates.get(userId);
    if (!state) return;

    state.step = "chain";
    state.useExisting = true;
    tokenSetupStates.set(userId, state);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("token_chain")
        .setPlaceholder("Select blockchain network")
        .addOptions(
          { label: "Celo", value: "celo" },
          { label: "Gnosis", value: "gnosis" },
          { label: "Base", value: "base" },
          { label: "Base Sepolia (testnet)", value: "base_sepolia" },
          { label: "Polygon", value: "polygon" },
        ),
    );

    await interaction.update({
      content: "**🪙 Token Setup**\n\nSelect the blockchain network:",
      components: [row],
    });
    return;
  }

  if (customId === "token_enter_address") {
    const modal = new ModalBuilder()
      .setCustomId("token_address_modal")
      .setTitle("Enter Token Address")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("token_address")
            .setLabel("Token Contract Address")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("0x...")
            .setRequired(true),
        ),
      );

    await interaction.showModal(modal);
    return;
  }
}

async function handleChannelSelect(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChannelSelectMenu()) return;

  const state = channelSetupStates.get(userId);
  if (!state) return;

  const channelId = interaction.values[0];
  const customId = interaction.customId;

  if (customId === "channel_transactions") {
    state.transactions = channelId;
  } else if (customId === "channel_contributions") {
    state.contributions = channelId;
  } else if (customId === "channel_logs") {
    state.logs = channelId;
  }

  // Auto-save when all channels are set
  if (state.transactions && state.contributions && state.logs) {
    const settings = await loadGuildSettings(guildId);
    if (settings) {
      settings.channels = {
        transactions: state.transactions,
        contributions: state.contributions,
        logs: state.logs,
      };
      await saveGuildSettings(guildId, settings);
      channelSetupStates.delete(userId);

      await interaction.update({
        content: "✅ **Channels Configured!**\n\nAll channels have been set up successfully.",
        components: [],
      });
    }
  } else {
    // Just acknowledge the interaction without updating the message
    // User can see their selections in the dropdowns
    await interaction.deferUpdate();
  }
}

async function handleStringSelect(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isStringSelectMenu()) return;

  const customId = interaction.customId;

  // Token chain selection
  if (customId === "token_chain") {
    const state = tokenSetupStates.get(userId);
    if (!state) return;

    state.chain = interaction.values[0] as Chain;
    state.step = "token";
    tokenSetupStates.set(userId, state);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("token_enter_address")
        .setLabel("Enter Token Address")
        .setStyle(ButtonStyle.Primary),
    );

    await interaction.update({
      content:
        `**🪙 Token Setup**\n\n✅ Chain: ${state.chain}\n\nClick the button to enter the token address:`,
      components: [row],
    });
    return;
  }

  // Reward active contributors
  if (customId === "reward_active") {
    const state = rewardEditStates.get(userId);
    if (!state || !state.id) return;

    state.onlyToActiveContributors = interaction.values[0] === "yes";
    rewardEditStates.set(userId, state);

    // Update saved settings
    const roles = await loadRoles(guildId);
    const roleIndex = roles.findIndex((r) => r.id === state.id);
    if (roleIndex >= 0) {
      roles[roleIndex].onlyToActiveContributors = state.onlyToActiveContributors;
      await saveRoles(guildId, roles);
    }

    await interaction.update({
      content: `✅ Updated! Only active contributors: **${
        state.onlyToActiveContributors ? "Yes" : "No"
      }**

You can continue to adjust settings:`,
      components: getRewardEditComponents(),
    });
    return;
  }

  // Cost active contributors
  if (customId === "cost_active") {
    const state = costEditStates.get(userId);
    if (!state || !state.id) return;

    state.onlyToActiveContributors = interaction.values[0] === "yes";
    costEditStates.set(userId, state);

    // Update saved settings
    const roles = await loadRoles(guildId);
    const roleIndex = roles.findIndex((r) => r.id === state.id);
    if (roleIndex >= 0) {
      roles[roleIndex].onlyToActiveContributors = state.onlyToActiveContributors;
      await saveRoles(guildId, roles);
    }

    await interaction.update({
      content: `✅ Updated! Only active contributors: **${
        state.onlyToActiveContributors ? "Yes" : "No"
      }**

You can continue to adjust settings:`,
      components: getCostEditComponents(),
    });
    return;
  }
}

async function handleRoleSelect(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isRoleSelectMenu()) return;

  const customId = interaction.customId;

  // Reward ping roles
  if (customId === "reward_ping") {
    const state = rewardEditStates.get(userId);
    if (!state || !state.id) return;

    state.rolesToPingIfEmpty = interaction.values;
    rewardEditStates.set(userId, state);

    // Update saved settings
    const roles = await loadRoles(guildId);
    const roleIndex = roles.findIndex((r) => r.id === state.id);
    if (roleIndex >= 0) {
      roles[roleIndex].rolesToPingIfEmpty = state.rolesToPingIfEmpty;
      await saveRoles(guildId, roles);
    }

    const rolesMention = state.rolesToPingIfEmpty.length > 0
      ? state.rolesToPingIfEmpty.map((r) => `<@&${r}>`).join(", ")
      : "_none_";

    await interaction.update({
      content: `✅ Updated! Roles to ping if empty: ${rolesMention}

You can continue to adjust settings:`,
      components: getRewardEditComponents(),
    });
    return;
  }

  // Cost ping roles
  if (customId === "cost_ping") {
    const state = costEditStates.get(userId);
    if (!state || !state.id) return;

    state.rolesToPingIfEmpty = interaction.values;
    costEditStates.set(userId, state);

    // Update saved settings
    const roles = await loadRoles(guildId);
    const roleIndex = roles.findIndex((r) => r.id === state.id);
    if (roleIndex >= 0) {
      roles[roleIndex].rolesToPingIfEmpty = state.rolesToPingIfEmpty;
      await saveRoles(guildId, roles);
    }

    const rolesMention = state.rolesToPingIfEmpty.length > 0
      ? state.rolesToPingIfEmpty.map((r) => `<@&${r}>`).join(", ")
      : "_none_";

    await interaction.update({
      content: `✅ Updated! Roles to ping if empty: ${rolesMention}

You can continue to adjust settings:`,
      components: getCostEditComponents(),
    });
    return;
  }
}

// Modal submission handler
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  const userId = interaction.user.id;
  const guildId = interaction.guildId!;

  // Handle book name modal
  if (interaction.customId === "book_name_modal") {
    return handleBookModal(interaction, userId, guildId);
  }

  // Handle mint details modal
  if (interaction.customId === "mint_details_modal") {
    return handleMintModal(interaction, userId, guildId);
  }

  const state = tokenSetupStates.get(userId);
  if (!state) return;

  async function addTokenToSettings(
    guildId: string,
    tokenInfo: { name: string; symbol: string; decimals: number; chain: Chain; address: BlockchainAddress; mintable: boolean },
  ) {
    const settings = await loadGuildSettings(guildId) || {
      guild: {
        id: guildId,
        name: interaction.guild!.name,
        icon: interaction.guild!.icon,
      },
      creator: {
        id: interaction.user.id,
        username: interaction.user.username,
        globalName: interaction.user.globalName,
        avatar: interaction.user.avatar,
      },
      channels: {
        transactions: "",
        contributions: "",
        logs: "",
      },
    };

    // Add to tokens array (create if doesn't exist)
    const tokens = (settings as any).tokens || [];
    tokens.push({
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      decimals: tokenInfo.decimals,
      chain: tokenInfo.chain,
      address: tokenInfo.address,
      mintable: tokenInfo.mintable,
    });
    (settings as any).tokens = tokens;

    await saveGuildSettings(guildId, settings);
  }

  if (interaction.customId === "token_create_modal") {
    const tokenName = interaction.fields.getTextInputValue("token_name");
    const tokenSymbol = interaction.fields.getTextInputValue("token_symbol");

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      // Deploy token on Gnosis chain
      const tokenAddress = await deployTokenContract("gnosis", tokenName, tokenSymbol);
      console.log(">>> deployed token", tokenName, tokenSymbol, "at", tokenAddress);

      tokenSetupStates.delete(userId);
      await addTokenToSettings(guildId, {
        name: tokenName,
        symbol: tokenSymbol,
        decimals: 6,
        chain: "gnosis",
        address: tokenAddress as BlockchainAddress,
        mintable: true, // Deployed tokens are always mintable
      });
      
      const explorerUrl = `https://gnosisscan.io/token/${tokenAddress}`;
      const shortAddr = `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`;
      
      await interaction.editReply({
        content: [
          "✅ **Token deployed successfully!**",
          "",
          `**Token:** ${tokenName} (${tokenSymbol})`,
          `**Address:** [gnosis:${shortAddr}](<${explorerUrl}>)`,
          "",
          "Next, run `/setup-channels` to configure the channels!",
        ].join("\n"),
      });
    } catch (error) {
      console.error("Error deploying token:", error);
      await interaction.editReply({
        content: `❌ Failed to deploy token.\n\n${error}`,
      });
    }
    return;
  }

  if (interaction.customId === "token_address_modal") {
    if (!state || !state.chain) return;

    const tokenAddress = interaction.fields.getTextInputValue("token_address") as BlockchainAddress;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const tokenInfo = await fetchTokenInfo(state.chain, tokenAddress);

      // Check if bot has MINTER role on this token
      const botAddress = botWallet.account?.address as string;
      let mintable = false;
      let mintableNote = "";
      
      try {
        mintable = await hasRole(state.chain as SupportedChain, tokenAddress, MINTER_ROLE, botAddress) as boolean;
      } catch (e) {
        // Token might not have AccessControl, assume not mintable
        mintable = false;
      }

      if (!mintable) {
        const shortBotAddr = `${botAddress.slice(0, 6)}…${botAddress.slice(-4)}`;
        mintableNote = `\n\n⚠️ **Not mintable** — Bot doesn't have MINTER role.\nTo make it mintable, grant MINTER role to: \`${botAddress}\``;
      }

      await addTokenToSettings(guildId, {
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        chain: state.chain,
        address: tokenAddress,
        mintable,
      });

      tokenSetupStates.delete(userId);

      const explorerUrl = getExplorerUrl(state.chain, tokenAddress);
      const shortAddr = `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`;

      await interaction.editReply({
        content: [
          "✅ **Token Added!**",
          "",
          `**Token:** ${tokenInfo.name} (${tokenInfo.symbol})`,
          `**Address:** [${state.chain}:${shortAddr}](<${explorerUrl}>)`,
          `**Mintable:** ${mintable ? "Yes ✅" : "No ❌"}`,
          mintableNote,
          "",
          "Next, run `/setup-channels` to configure the channels!",
        ].join("\n"),
      });
    } catch (error) {
      console.error("Error fetching token info:", error);
      await interaction.editReply({
        content:
          `❌ Failed to fetch token information. Please check the address and chain.\n\nError: ${error}`,
      });
    }
  }
});

// UI helper functions
function getRewardEditComponents() {
  const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("reward_active")
      .setPlaceholder("Only active contributors?")
      .addOptions(
        { label: "Yes - only active contributors", value: "yes" },
        { label: "No - all role members", value: "no" },
      ),
  );

  const row2 = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId("reward_ping")
      .setPlaceholder("Roles to ping if target role is empty (optional)")
      .setMinValues(0)
      .setMaxValues(5),
  );

  return [row1, row2];
}

function getCostEditComponents() {
  const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("cost_active")
      .setPlaceholder("Only active contributors?")
      .addOptions(
        { label: "Yes - only active contributors", value: "yes" },
        { label: "No - all role members", value: "no" },
      ),
  );

  const row2 = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId("cost_ping")
      .setPlaceholder("Roles to ping if target role is empty (optional)")
      .setMinValues(0)
      .setMaxValues(5),
  );

  return [row1, row2];
}

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

// Start bot
client.login(BOT_TOKEN);

// Health check HTTP server
const PORT = parseInt(Deno.env.get("PORT") || "8080");
Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response("Not Found", { status: 404 });
});

console.log(`🏥 Health check server running on http://localhost:${PORT}/health`);

// Graceful shutdown
Deno.addSignalListener("SIGINT", async () => {
  console.log("\n🛑 Shutting down bot...");
  await client.destroy();
  Deno.exit(0);
});

Deno.addSignalListener("SIGTERM", async () => {
  console.log("\n🛑 Shutting down bot...");
  await client.destroy();
  Deno.exit(0);
});
