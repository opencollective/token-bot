import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { mintTokens, SupportedChain, ChainConfig } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";

// Mint state management
interface MintState {
  step: "token" | "details";
  tokenIndex?: number; // Index in tokens array, or -1 for contributionToken
  tokenSymbol?: string;
  tokenAddress?: string;
  tokenChain?: string;
  tokenDecimals?: number;
}

export const mintStates = new Map<string, MintState>();

// Parse user mentions from a string, returns array of user IDs
function parseUserMentions(input: string): string[] {
  const mentionRegex = /<@!?(\d+)>/g;
  const userIds: string[] = [];
  let match;
  while ((match = mentionRegex.exec(input)) !== null) {
    userIds.push(match[1]);
  }
  return userIds;
}

// Get all mintable tokens from settings
interface MintableToken {
  index: number; // -1 for contributionToken, -2 for fiatToken, >=0 for tokens array
  name: string;
  symbol: string;
  address: string;
  chain: string;
  decimals: number;
}

function getMintableTokens(settings: any): MintableToken[] {
  const tokens: MintableToken[] = [];

  // Check contributionToken (legacy, assume mintable if exists)
  if (settings.contributionToken?.address) {
    tokens.push({
      index: -1,
      name: settings.contributionToken.name,
      symbol: settings.contributionToken.symbol,
      address: settings.contributionToken.address,
      chain: settings.contributionToken.chain,
      decimals: settings.contributionToken.decimals,
    });
  }

  // Check tokens array (only mintable ones)
  const additionalTokens = settings.tokens || [];
  for (let i = 0; i < additionalTokens.length; i++) {
    const token = additionalTokens[i];
    if (token?.address && token.mintable === true) {
      tokens.push({
        index: i,
        name: token.name,
        symbol: token.symbol,
        address: token.address,
        chain: token.chain,
        decimals: token.decimals,
      });
    }
  }

  return tokens;
}

export default async function handleMintCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.reply({
      content: "❌ Guild settings not found. Run `/add-token` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const mintableTokens = getMintableTokens(guildSettings);

  if (mintableTokens.length === 0) {
    await interaction.reply({
      content: "❌ No mintable tokens configured. Add a token with `/add-token` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // If only one mintable token, skip selection and go straight to modal
  if (mintableTokens.length === 1) {
    const token = mintableTokens[0];
    mintStates.set(userId, {
      step: "details",
      tokenIndex: token.index,
      tokenSymbol: token.symbol,
      tokenAddress: token.address,
      tokenChain: token.chain,
      tokenDecimals: token.decimals,
    });

    const modal = getMintModal(token.symbol);
    await interaction.showModal(modal);
    return;
  }

  // Multiple tokens - show selection
  mintStates.set(userId, { step: "token" });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("mint_token_select")
    .setPlaceholder("Select a token to mint...")
    .addOptions(
      mintableTokens.map((token) => ({
        label: `${token.name} (${token.symbol})`,
        description: `${token.chain}:${token.address.slice(0, 6)}…${token.address.slice(-4)}`,
        value: String(token.index),
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  
  const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("mint_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    content: "🪙 **Mint Tokens**\n\nSelect which token to mint:",
    components: [row, cancelRow],
    flags: MessageFlags.Ephemeral,
  });
}

function getMintModal(tokenSymbol: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("mint_details_modal")
    .setTitle(`Mint ${tokenSymbol}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("mint_users")
          .setLabel("Users (mention with @)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("@user1 @user2 @user3")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("mint_amount")
          .setLabel("Amount per user")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g., 10")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("mint_message")
          .setLabel("Message (optional)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g., Thanks for your contribution!")
          .setRequired(false),
      ),
    );
}

// Handle token selection
export async function handleMintSelect(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isStringSelectMenu()) return;

  const state = mintStates.get(userId);
  if (!state) {
    await interaction.update({
      content: "⚠️ Session expired. Please run /mint again.",
      components: [],
    });
    return;
  }

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) return;

  const tokenIndex = parseInt(interaction.values[0]);
  const mintableTokens = getMintableTokens(guildSettings);
  const token = mintableTokens.find((t) => t.index === tokenIndex);

  if (!token) {
    await interaction.update({
      content: "⚠️ Token not found.",
      components: [],
    });
    return;
  }

  state.step = "details";
  state.tokenIndex = token.index;
  state.tokenSymbol = token.symbol;
  state.tokenAddress = token.address;
  state.tokenChain = token.chain;
  state.tokenDecimals = token.decimals;
  mintStates.set(userId, state);

  const modal = getMintModal(token.symbol);
  await interaction.showModal(modal);
}

// Handle cancel button
export async function handleMintButton(
  interaction: Interaction,
  userId: string,
) {
  if (!interaction.isButton()) return;

  if (interaction.customId === "mint_cancel") {
    mintStates.delete(userId);
    await interaction.update({
      content: "❌ Mint cancelled.",
      components: [],
    });
  }
}

// Handle modal submission
export async function handleMintModal(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isModalSubmit()) return;

  const state = mintStates.get(userId);
  if (!state || !state.tokenAddress || !state.tokenChain) {
    await interaction.reply({
      content: "⚠️ Session expired. Please run /mint again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const usersInput = interaction.fields.getTextInputValue("mint_users");
  const amountStr = interaction.fields.getTextInputValue("mint_amount");
  const message = interaction.fields.getTextInputValue("mint_message") || undefined;

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    await interaction.reply({
      content: "❌ Invalid amount. Please enter a positive number.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const recipientUserIds = parseUserMentions(usersInput);
  if (recipientUserIds.length === 0) {
    await interaction.reply({
      content: "❌ No valid users found. Please mention users with @username.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.editReply({ content: "❌ Guild settings not found." });
    return;
  }

  const chain = state.tokenChain as SupportedChain;
  const chainId = ChainConfig[chain].id;
  const tokenSymbol = state.tokenSymbol!;
  const tokenAddress = state.tokenAddress!;
  const tokenDecimals = state.tokenDecimals || 6;

  const results: { userId: string; success: boolean; hash?: string; error?: string }[] = [];

  // Mint for each user
  for (const recipientUserId of recipientUserIds) {
    try {
      const recipientAddress = await getAccountAddressFromDiscordUserId(recipientUserId);
      
      const hash = await mintTokens(
        chain,
        tokenAddress,
        recipientAddress,
        amount.toString(),
        tokenDecimals,
      );

      if (hash) {
        results.push({ userId: recipientUserId, success: true, hash });

        const txUri = `ethereum:${chainId}:tx:${hash}` as URI;

        // Publish metadata to Nostr
        try {
          const nostr = Nostr.getInstance();
          const nostrContent = message || `Minted ${amount} ${tokenSymbol} for Discord user`;

          await nostr.publishMetadata(txUri, {
            content: nostrContent,
            tags: [
              ["t", "mint"],
              ["amount", amount.toString()],
            ],
          });
        } catch (error) {
          console.error("Error sending Nostr annotation:", error);
        }
      } else {
        results.push({ userId: recipientUserId, success: false, error: "No hash returned" });
      }
    } catch (error) {
      console.error(`Error minting for user ${recipientUserId}:`, error);
      results.push({ userId: recipientUserId, success: false, error: String(error) });
    }
  }

  // Post to Discord transactions channel
  const successfulMints = results.filter((r) => r.success);
  if (successfulMints.length > 0 && guildSettings.channels?.transactions && interaction.guild) {
    try {
      const transactionsChannel = (await interaction.guild.channels.fetch(
        guildSettings.channels.transactions
      )) as TextChannel;

      if (transactionsChannel) {
        const recipientMentions = successfulMints.map((r) => `<@${r.userId}>`).join(", ");
        let discordMessage = `🪙 <@${userId}> minted ${amount} ${tokenSymbol} each for ${recipientMentions}`;
        if (message) {
          discordMessage += `: ${message}`;
        }
        await transactionsChannel.send(discordMessage);
      }
    } catch (error) {
      console.error("Error sending message to transactions channel:", error);
    }
  }

  // Build reply message
  const successCount = successfulMints.length;
  const failCount = results.length - successCount;

  let replyContent = "";
  if (successCount > 0) {
    const recipientMentions = successfulMints.map((r) => `<@${r.userId}>`).join(", ");
    replyContent = `✅ Minted ${amount} ${tokenSymbol} each for ${recipientMentions}`;
    if (message) {
      replyContent += `\n📝 ${message}`;
    }
  }

  if (failCount > 0) {
    const failedMints = results.filter((r) => !r.success);
    const failedMentions = failedMints.map((r) => `<@${r.userId}>`).join(", ");
    replyContent += `\n❌ Failed to mint for: ${failedMentions}`;
  }

  if (successCount === 0) {
    replyContent = "❌ Failed to mint tokens for all users.";
  }

  mintStates.delete(userId);
  await interaction.editReply({ content: replyContent });
}
