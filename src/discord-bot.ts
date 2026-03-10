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
  GuildSettings,
  Product,
  RoleSetting,
  Token,
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
// Role editing is now handled via /roles command with modals

import { getNativeBalance, getTokenHolderCount, getTotalSupply, getWalletClient, hasRole, MINTER_ROLE, SupportedChain } from "./lib/blockchain.ts";
import handleMintCommand, { handleMintAutocomplete } from "./commands/mint.ts";
import handleBurnCommand, { handleBurnAutocomplete } from "./commands/burn.ts";
import handlePermissionsCommand from "./commands/permissions.ts";
import handleSendCommand, { handleSendInteraction, sendStates } from "./commands/send.ts";
import handleBalanceCommand from "./commands/balance.ts";
import { handleBookButton, handleBookCommand, handleBookModal, handleBookSelect } from "./commands/book.ts";
import { handleCancelButton, handleCancelCommand, handleCancelSelect } from "./commands/cancel.ts";
import { handleBookingsButton, handleBookingsCommand, handleBookingsModal, handleBookingsSelect } from "./commands/bookings.ts";
import { GoogleCalendarClient } from "./lib/googlecalendar.ts";
import { setDiscordClient, startApiServer } from "./api.ts";

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
import { disabledCalendars } from "./lib/calendar-state.ts";

try {
  const keyFilePath = Deno.env.get("GOOGLE_ACCOUNT_KEY_FILEPATH") || "./google-account-key.json";
  await Deno.stat(keyFilePath);
  calendarEnabled = true;
  console.log("✅ Google Calendar credentials found");
} catch (error) {
  console.warn("⚠️  Google Calendar credentials not found or invalid");
  console.warn("⚠️  /book and /cancel commands will be disabled");
  console.warn(`⚠️  Set GOOGLE_ACCOUNT_KEY_FILEPATH or place credentials at ./google-account-key.json`);
}

// Check calendar write permissions in the background (non-blocking)
async function checkCalendarPermissions() {
  if (!calendarEnabled) return;
  console.log("📅 Checking calendar write permissions...");
  const dataDir = Deno.env.get("DATA_DIR") || "./data";
  
  try {
    const testClient = new GoogleCalendarClient();
    for await (const guildEntry of Deno.readDir(dataDir)) {
      if (!guildEntry.isDirectory) continue;
      
      const productsPath = `${dataDir}/${guildEntry.name}/products.json`;
      try {
        const productsJson = await Deno.readTextFile(productsPath);
        const products = JSON.parse(productsJson) as Product[];
        
        for (const product of products) {
          if (product.calendarId) {
            const hasAccess = await testClient.testWriteAccess(product.calendarId);
            if (hasAccess) {
              console.log(`  ✅ ${product.name}: write access OK`);
            } else {
              console.warn(`  ❌ ${product.name}: NO write access - booking disabled`);
              disabledCalendars.add(product.calendarId);
            }
          }
        }
      } catch {
        // No products.json for this guild, skip
      }
    }
  } catch (error) {
    console.warn("⚠️  Could not check calendar permissions:", error);
  }
  
  if (disabledCalendars.size > 0) {
    console.warn(`⚠️  ${disabledCalendars.size} calendar(s) disabled due to missing write permissions`);
  } else {
    console.log("📅 All calendars OK");
  }
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
      commandsToRegister = commands.filter(cmd => cmd.name !== "book" && cmd.name !== "cancel" && cmd.name !== "bookings");
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
  
  // Start API server and pass Discord client reference
  setDiscordClient(client);
  startApiServer();
  
  // Check calendar permissions in background (don't block bot startup)
  checkCalendarPermissions().catch(err => console.error("Calendar check failed:", err));
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

    // Handle autocomplete
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "mint") {
        return handleMintAutocomplete(interaction, guildId);
      }
      if (interaction.commandName === "burn") {
        return handleBurnAutocomplete(interaction, guildId);
      }
      return;
    }

    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "list-tokens") {
        return handleListTokensCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "edit-tokens") {
        return handleEditTokensCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "setup-channels") {
        return handleSetupChannelsCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "mint") {
        return handleMintCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "burn") {
        return handleBurnCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "send") {
        return handleSendCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "balance") {
        return handleBalanceCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "roles") {
        return handleRolesCommand(interaction, userId, guildId);
      }
      if (interaction.commandName === "permissions") {
        return handlePermissionsCommand(interaction, userId, guildId);
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
      if (interaction.commandName === "bookings") {
        if (!calendarEnabled) {
          await interaction.reply({
            content: "⚠️ Calendar features are disabled. Google Calendar credentials not found.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        return handleBookingsCommand(interaction, userId, guildId);
      }
    }

    // Handle component interactions
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("book_")) {
        return handleBookButton(interaction, userId, guildId);
      }
      if (
        interaction.customId.startsWith("cancel_confirm_") ||
        interaction.customId === "cancel_abort"
      ) {
        return handleCancelButton(interaction, userId);
      }
      if (interaction.customId === "send_confirm" || interaction.customId === "send_cancel") {
        return handleSendInteraction(interaction, userId, guildId);
      }
      if (interaction.customId.startsWith("bookings_")) {
        return handleBookingsButton(interaction, userId, guildId);
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
      if (interaction.customId.startsWith("bookings_")) {
        return handleBookingsSelect(interaction, userId, guildId);
      }
      if (interaction.customId === "send_token_select") {
        return handleSendInteraction(interaction, userId, guildId);
      }
      return handleStringSelect(interaction, userId, guildId);
    }
    if (interaction.isRoleSelectMenu()) {
      return handleRoleSelectMenu(interaction, userId, guildId);
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
async function formatTokenList(settings: GuildSettings | null, guild: any = null): Promise<string> {
  if (!settings || settings.tokens.length === 0) {
    return "No tokens configured yet.";
  }

  const tokenLines: string[] = [];

  for (const token of settings.tokens) {
    const explorerUrl = getExplorerUrl(token.chain, token.address);
    const stats = await fetchTokenStats(token.chain, token.address, token.decimals);

    const shortAddr = `${token.address.slice(0, 6)}…${token.address.slice(-4)}`;
    let tokenInfo = `**${token.name} (${token.symbol})**`;
    if (token.mintable) tokenInfo += " 🪙";
    tokenInfo += `\n• Address: [${token.chain}:${shortAddr}](<${explorerUrl}>)`;
    tokenInfo += `\n• Supply: ${stats.totalSupply} ${token.symbol}`;
    if (stats.holders !== null) {
      tokenInfo += ` · ${stats.holders.toLocaleString("en-US")} holders`;
    }

    // Show minters for mintable tokens
    if (token.mintable && token.minterRoleId && guild) {
      try {
        const role = await guild.roles.fetch(token.minterRoleId);
        if (role) {
          const members = await guild.members.fetch();
          const roleMembers = members.filter((m: any) => m.roles.cache.has(token.minterRoleId));
          if (roleMembers.size > 0) {
            const minterNames = roleMembers.map((m: any) => `@${m.displayName}`).join(", ");
            tokenInfo += `\n• Minters: ${minterNames}`;
          }
        }
      } catch (error) {
        console.error("Error fetching minter role members:", error);
      }
    }

    tokenLines.push(tokenInfo);
  }

  return tokenLines.join("\n\n");
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
  const tokenList = await formatTokenList(settings, interaction.guild);

  await interaction.editReply({
    content: `**🪙 Configured Tokens**\n\n${tokenList}\n\n🪙 = mintable`,
  });
}

async function handleEditTokensCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Show existing tokens first
  const settings = await loadGuildSettings(guildId);
  const tokenList = await formatTokenList(settings, interaction.guild);
  const hasTokens = settings && settings.tokens.length > 0;

  tokenSetupStates.set(userId, { step: "choice" });

  const buttons = [
    new ButtonBuilder()
      .setCustomId("token_create_new")
      .setLabel("Create New Token")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("token_use_existing")
      .setLabel("Add Existing Token")
      .setStyle(ButtonStyle.Secondary),
  ];

  // Only show "Edit Token" button if tokens exist
  if (hasTokens) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId("token_edit")
        .setLabel("Edit Token")
        .setStyle(ButtonStyle.Secondary)
    );
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

  const header = hasTokens
    ? `**🪙 Current Tokens**\n\n${tokenList}\n\n---\n\n**Manage Tokens**\n\nChoose an action:`
    : "**🪙 Token Setup**\n\nNo tokens configured yet.\n\nChoose an action:";

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

async function handleRolesCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  const roles = await loadRoles(guildId);

  if (roles.length === 0) {
    await interaction.reply({
      content: "No roles configured yet.\n\nUse the button below to add a role.",
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("roles_add")
            .setLabel("Add Role")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Filter out roles with no rewards or costs
  const activeRoles = roles.filter((r) => (r.amountToMint || 0) > 0 || (r.amountToBurn || 0) > 0);

  if (activeRoles.length === 0) {
    await interaction.reply({
      content: "No roles with active rewards or costs configured.\n\nUse the button below to add a role.",
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("roles_add")
            .setLabel("Add Role")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Build role list (use original index for edit references)
  const activeWithIndex = activeRoles.map((r) => ({ role: r, idx: roles.indexOf(r) }));

  const lines = activeWithIndex.map(({ role: r, idx }, i) => {
    const parts: string[] = [];
    if (r.amountToMint) parts.push(`+${r.amountToMint.toLocaleString()} tokens`);
    if (r.amountToBurn) parts.push(`-${r.amountToBurn.toLocaleString()} tokens`);
    const freq = r.frequency || "monthly";
    const flags: string[] = [];
    if (r.onlyToActiveContributors) flags.push("active only");
    if (r.rolesToPingIfEmpty?.length) flags.push(`pings ${r.rolesToPingIfEmpty.length} role(s) if empty`);
    const flagStr = flags.length ? ` _(${flags.join(", ")})_` : "";
    return `${i + 1}. <@&${r.id}> — ${parts.join(", ")} ${freq}${flagStr}`;
  });

  const selectOptions = activeWithIndex.map(({ role: r, idx }, i) => ({
    label: r.name || `Role #${i + 1}`,
    description: `${r.amountToMint ? `+${r.amountToMint}` : ""}${r.amountToMint && r.amountToBurn ? " / " : ""}${r.amountToBurn ? `-${r.amountToBurn}` : ""} ${r.frequency || "monthly"}`,
    value: `${idx}`,
  }));

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("roles_select")
        .setPlaceholder("Select a role to edit...")
        .addOptions(selectOptions),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("roles_add")
        .setLabel("Add Role")
        .setStyle(ButtonStyle.Primary),
    ),
  ];

  await interaction.reply({
    content: `**⚙️ Role Configuration**\n\n${lines.join("\n")}`,
    components,
    flags: MessageFlags.Ephemeral,
  });
}

// Component handlers
async function handleButton(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;

  // Roles: Add new role — show role picker
  if (customId === "roles_add") {
    const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId("roles_add_pick")
        .setPlaceholder("Select a role to configure...")
    );

    await interaction.update({
      content: "**Select a role to add:**",
      components: [row],
    });
    return;
  }

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

  if (customId === "token_edit") {
    const settings = await loadGuildSettings(guildId);
    if (!settings || settings.tokens.length === 0) {
      await interaction.reply({
        content: "❌ No tokens configured yet.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    const options = settings.tokens.map((token, index) => ({
      label: `${token.name} (${token.symbol})`,
      value: index.toString(),
      description: `${token.chain}: ${token.address.slice(0, 6)}...${token.address.slice(-4)}`,
    }));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("token_edit_select")
        .setPlaceholder("Select a token to edit")
        .addOptions(options.slice(0, 25)), // Discord limit
    );

    await interaction.editReply({
      content: "**🪙 Edit Token**\n\nSelect a token to edit:",
      components: [row],
    });
    return;
  }

  // Token remove button
  if (customId.startsWith("token_remove_")) {
    const tokenIndex = parseInt(customId.replace("token_remove_", ""));
    const settings = await loadGuildSettings(guildId);
    
    if (!settings || !settings.tokens[tokenIndex]) {
      await interaction.reply({
        content: "❌ Token not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const token = settings.tokens[tokenIndex];
    
    await interaction.update({
      content: `⚠️ **Remove Token?**\n\nAre you sure you want to remove **${token.name} (${token.symbol})** from this server?\n\n⚠️ This action cannot be undone!`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`token_remove_confirm_${tokenIndex}`)
            .setLabel("Yes, Remove Token")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("token_remove_cancel")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary),
        )
      ],
    });
    return;
  }

  // Token remove confirmation
  if (customId.startsWith("token_remove_confirm_")) {
    const tokenIndex = parseInt(customId.replace("token_remove_confirm_", ""));
    const settings = await loadGuildSettings(guildId);
    
    if (!settings || !settings.tokens[tokenIndex]) {
      await interaction.update({
        content: "❌ Token not found.",
        components: [],
      });
      return;
    }

    const token = settings.tokens[tokenIndex];
    settings.tokens.splice(tokenIndex, 1);
    await saveGuildSettings(guildId, settings);

    await interaction.update({
      content: `✅ Removed token: **${token.name} (${token.symbol})**`,
      components: [],
    });
    return;
  }

  // Token remove cancel
  if (customId === "token_remove_cancel") {
    await interaction.update({
      content: "❌ Token removal cancelled.",
      components: [],
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

// State to hold the selected role ID between role picker and modal
const rolesAddState = new Map<string, { roleId: string; roleName: string }>();

async function handleRoleSelectMenu(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isRoleSelectMenu()) return;

  if (interaction.customId === "roles_add_pick") {
    const role = interaction.roles.first();
    if (!role) return;

    // Store selected role for the modal
    rolesAddState.set(userId, { roleId: role.id, roleName: role.name });

    const modal = new ModalBuilder()
      .setCustomId("roles_add_modal")
      .setTitle(`Configure: ${role.name}`);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("tokens_to_mint")
          .setLabel("Tokens to mint (reward, 0 for none)")
          .setStyle(TextInputStyle.Short)
          .setValue("0")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("tokens_to_burn")
          .setLabel("Tokens to burn (cost, 0 for none)")
          .setStyle(TextInputStyle.Short)
          .setValue("0")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("frequency")
          .setLabel("Frequency (daily / weekly / monthly)")
          .setStyle(TextInputStyle.Short)
          .setValue("monthly")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("active_only")
          .setLabel("Only users active in #contributions? (yes/no)")
          .setStyle(TextInputStyle.Short)
          .setValue("no")
          .setRequired(true),
      ),
    );

    await interaction.showModal(modal);
    return;
  }
}

async function handleStringSelect(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isStringSelectMenu()) return;

  const customId = interaction.customId;

  // Roles: select a role to edit
  if (customId === "roles_select") {
    const idx = parseInt(interaction.values[0]);
    const roles = await loadRoles(guildId);
    const role = roles[idx];
    if (!role) {
      await interaction.update({ content: "⚠️ Role not found.", components: [] });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`roles_edit_modal_${idx}`)
      .setTitle(`Edit: ${role.name || `Role #${idx + 1}`}`);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("role_name")
          .setLabel("Role name")
          .setStyle(TextInputStyle.Short)
          .setValue(role.name || "")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("tokens_to_mint")
          .setLabel("Tokens to mint (reward, 0 for none)")
          .setStyle(TextInputStyle.Short)
          .setValue(String(role.amountToMint || 0))
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("tokens_to_burn")
          .setLabel("Tokens to burn (cost, 0 for none)")
          .setStyle(TextInputStyle.Short)
          .setValue(String(role.amountToBurn || 0))
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("frequency")
          .setLabel("Frequency (daily / weekly / monthly)")
          .setStyle(TextInputStyle.Short)
          .setValue(role.frequency || "monthly")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("active_only")
          .setLabel("Only users active in #contributions? (yes/no)")
          .setStyle(TextInputStyle.Short)
          .setValue(role.onlyToActiveContributors ? "yes" : "no")
          .setRequired(true),
      ),
    );

    await interaction.showModal(modal);
    return;
  }

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

  // Token edit selection — show modal (must NOT deferUpdate before showModal)
  if (customId === "token_edit_select") {
    const settings = await loadGuildSettings(guildId);
    if (!settings || settings.tokens.length === 0) {
      await interaction.reply({
        content: "❌ No tokens configured yet.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const tokenIndex = parseInt(interaction.values[0]);
    const token = settings.tokens[tokenIndex];
    
    if (!token) {
      await interaction.reply({
        content: "❌ Token not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`token_edit_modal_${tokenIndex}`)
      .setTitle(`Edit ${token.symbol}`);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("token_name")
          .setLabel("Token Name")
          .setStyle(TextInputStyle.Short)
          .setValue(token.name)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("token_symbol")
          .setLabel("Token Symbol")
          .setStyle(TextInputStyle.Short)
          .setValue(token.symbol)
          .setRequired(true),
      ),
    );

    await interaction.showModal(modal);
    return;
  }


}



// Modal submission handler
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  const userId = interaction.user.id;
  const guildId = interaction.guildId!;

  // Handle book modals
  if (interaction.customId === "book_name_modal" || interaction.customId === "book_date_modal") {
    return handleBookModal(interaction, userId, guildId);
  }

  // Handle bookings modals
  if (interaction.customId === "bookings_url_modal") {
    return handleBookingsModal(interaction, userId, guildId);
  }

  // Handle roles add modal
  if (interaction.customId === "roles_add_modal") {
    const state = rolesAddState.get(userId);
    if (!state) {
      await interaction.reply({ content: "⚠️ Session expired. Please try again.", flags: MessageFlags.Ephemeral });
      return;
    }
    rolesAddState.delete(userId);

    const { roleId, roleName } = state;
    const mint = parseInt(interaction.fields.getTextInputValue("tokens_to_mint")) || 0;
    const burn = parseInt(interaction.fields.getTextInputValue("tokens_to_burn")) || 0;
    const freqRaw = interaction.fields.getTextInputValue("frequency").trim().toLowerCase();
    const frequency = (["daily", "weekly", "monthly"].includes(freqRaw) ? freqRaw : "monthly") as "daily" | "weekly" | "monthly";
    const activeOnly = interaction.fields.getTextInputValue("active_only").trim().toLowerCase() === "yes";

    const roles = await loadRoles(guildId);

    // Update existing or add new
    const existing = roles.find((r) => r.id === roleId);
    if (existing) {
      existing.name = roleName;
      existing.amountToMint = mint;
      existing.amountToBurn = burn;
      existing.frequency = frequency;
      existing.onlyToActiveContributors = activeOnly;
    } else {
      roles.push({
        id: roleId,
        name: roleName,
        amountToMint: mint,
        amountToBurn: burn,
        frequency,
        rolesToPingIfEmpty: [],
        onlyToActiveContributors: activeOnly,
      });
    }
    await saveRoles(guildId, roles);

    await interaction.reply({
      content: `✅ ${existing ? "Updated" : "Added"} <@&${roleId}>\n` +
        `${mint ? `+${mint.toLocaleString()} tokens ` : ""}${burn ? `-${burn.toLocaleString()} tokens ` : ""}${frequency}\n` +
        `Active only: ${activeOnly ? "Yes" : "No"}\n\n` +
        `Use \`/roles\` to view all roles.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Handle roles edit modal
  if (interaction.customId.startsWith("roles_edit_modal_")) {
    const idx = parseInt(interaction.customId.replace("roles_edit_modal_", ""));
    const roles = await loadRoles(guildId);
    const role = roles[idx];
    if (!role) {
      await interaction.reply({ content: "⚠️ Role not found.", flags: MessageFlags.Ephemeral });
      return;
    }

    role.name = interaction.fields.getTextInputValue("role_name").trim();
    role.amountToMint = parseInt(interaction.fields.getTextInputValue("tokens_to_mint")) || 0;
    role.amountToBurn = parseInt(interaction.fields.getTextInputValue("tokens_to_burn")) || 0;
    const freqRaw = interaction.fields.getTextInputValue("frequency").trim().toLowerCase();
    role.frequency = (["daily", "weekly", "monthly"].includes(freqRaw) ? freqRaw : "monthly") as "daily" | "weekly" | "monthly";
    role.onlyToActiveContributors = interaction.fields.getTextInputValue("active_only").trim().toLowerCase() === "yes";

    await saveRoles(guildId, roles);

    await interaction.reply({
      content: `✅ Updated <@&${role.id}> (${role.name})\n` +
        `${role.amountToMint ? `+${role.amountToMint.toLocaleString()} tokens ` : ""}${role.amountToBurn ? `-${role.amountToBurn.toLocaleString()} tokens ` : ""}${role.frequency}\n` +
        `Active only: ${role.onlyToActiveContributors ? "Yes" : "No"}\n\n` +
        `Use \`/roles\` to view all roles.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Handle token edit modal
  if (interaction.customId.startsWith("token_edit_modal_")) {
    const tokenIndex = parseInt(interaction.customId.replace("token_edit_modal_", ""));
    const settings = await loadGuildSettings(guildId);
    
    if (!settings || !settings.tokens[tokenIndex]) {
      await interaction.reply({
        content: "❌ Token not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const oldToken = settings.tokens[tokenIndex];
    const newName = interaction.fields.getTextInputValue("token_name");
    const newSymbol = interaction.fields.getTextInputValue("token_symbol");

    // Update token
    settings.tokens[tokenIndex] = {
      ...oldToken,
      name: newName,
      symbol: newSymbol,
    };

    // If token is mintable, handle minter role
    if (oldToken.mintable) {
      try {
        let minterRoleId = oldToken.minterRoleId;
        
        if (minterRoleId) {
          // Try to rename existing role
          const role = await interaction.guild!.roles.fetch(minterRoleId);
          if (role) {
            await role.setName(`${newSymbol}-minter`);
          } else {
            // Role doesn't exist, create new one
            const newRole = await interaction.guild!.roles.create({
              name: `${newSymbol}-minter`,
              reason: `Minter role for ${newSymbol} token`,
            });
            minterRoleId = newRole.id;
          }
        } else {
          // Create new minter role
          const newRole = await interaction.guild!.roles.create({
            name: `${newSymbol}-minter`,
            reason: `Minter role for ${newSymbol} token`,
          });
          minterRoleId = newRole.id;
        }
        
        settings.tokens[tokenIndex].minterRoleId = minterRoleId;
      } catch (error) {
        console.error("Error handling minter role:", error);
      }
    }

    await saveGuildSettings(guildId, settings);

    let successMessage = `✅ Updated token: **${newName} (${newSymbol})**`;
    if (oldToken.mintable && settings.tokens[tokenIndex].minterRoleId) {
      successMessage += `\n\n📝 Assign the <@&${settings.tokens[tokenIndex].minterRoleId}> role to people who should be able to mint this token.`;
    }

    // Show updated tokens with remove button
    const removeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`token_remove_${tokenIndex}`)
        .setLabel("Remove Token")
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({
      content: successMessage,
      components: [removeRow],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const state = tokenSetupStates.get(userId);
  if (!state) return;

  async function addTokenToSettings(
    guildId: string,
    tokenInfo: { name: string; symbol: string; decimals: number; chain: Chain; address: BlockchainAddress; mintable: boolean },
  ) {
    const settings: GuildSettings = (await loadGuildSettings(guildId)) || {
      tokens: [],
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

    // Add to tokens array
    const newToken: Token = {
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      decimals: tokenInfo.decimals,
      chain: tokenInfo.chain,
      address: tokenInfo.address,
      mintable: tokenInfo.mintable,
    };

    // Auto-create minter role for mintable tokens
    if (tokenInfo.mintable && interaction.guild) {
      try {
        const roleName = `${tokenInfo.symbol}-minter`;
        // Check if role already exists
        const existingRole = interaction.guild.roles.cache.find((r) => r.name === roleName);
        if (existingRole) {
          newToken.minterRoleId = existingRole.id;
        } else {
          const role = await interaction.guild.roles.create({
            name: roleName,
            reason: `Minter role for ${tokenInfo.symbol} token`,
          });
          newToken.minterRoleId = role.id;
        }
      } catch (error) {
        console.error("Error creating minter role:", error);
      }
    }

    settings.tokens.push(newToken);
    await saveGuildSettings(guildId, settings);

    return newToken;
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
      const addedToken = await addTokenToSettings(guildId, {
        name: tokenName,
        symbol: tokenSymbol,
        decimals: 6,
        chain: "gnosis",
        address: tokenAddress as BlockchainAddress,
        mintable: true, // Deployed tokens are always mintable
      });
      
      const explorerUrl = `https://gnosisscan.io/token/${tokenAddress}`;
      const shortAddr = `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`;
      
      const lines = [
        "✅ **Token deployed successfully!**",
        "",
        `**Token:** ${tokenName} (${tokenSymbol})`,
        `**Address:** [gnosis:${shortAddr}](<${explorerUrl}>)`,
      ];
      if (addedToken.minterRoleId) {
        lines.push("", `📝 Assign the <@&${addedToken.minterRoleId}> role to people who should be able to mint it.`);
      }
      lines.push("", "Next, run `/setup-channels` to configure the channels!");
      
      await interaction.editReply({ content: lines.join("\n") });
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

      const addedToken = await addTokenToSettings(guildId, {
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

      const lines = [
        "✅ **Token Added!**",
        "",
        `**Token:** ${tokenInfo.name} (${tokenInfo.symbol})`,
        `**Address:** [${state.chain}:${shortAddr}](<${explorerUrl}>)`,
        `**Mintable:** ${mintable ? "Yes ✅" : "No ❌"}`,
        mintableNote,
      ];
      if (addedToken.minterRoleId) {
        lines.push("", `📝 Assign the <@&${addedToken.minterRoleId}> role to people who should be able to mint it.`);
      }
      lines.push("", "Next, run `/setup-channels` to configure the channels!");

      await interaction.editReply({ content: lines.join("\n") });
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
