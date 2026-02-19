import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { loadGuildSettings } from "../lib/utils.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import {
  BundlerService,
  CommunityConfig,
  callOnCardCallData,
  getAccountAddress,
  getAccountBalance,
  getCardAddress,
  tokenTransferCallData,
  tokenTransferEventTopic,
  type UserOpData,
  type UserOpExtraData,
} from "@citizenwallet/sdk";
import { formatUnits, parseUnits } from "@wevm/viem";
import { SupportedChain, ChainConfig, getBalance } from "../lib/blockchain.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import type { GuildSettings, Token } from "../types.ts";

// ── State for multi-step send flow ──────────────────────────────────────────

interface SendState {
  recipientId: string;
  recipientName: string;
  guildId: string;
  senderId: string;
  senderAddress: string;
  tokenIndex?: number;
  token?: Token;
  balances: Map<number, bigint>; // tokenIndex → balance
}

export const sendStates = new Map<string, SendState>();

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildCommunityConfig(guildSettings: GuildSettings, token: Token): any {
  const chain = token.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;
  const cardManagerAddress = "0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28";
  const entrypointAddress = "0x7079253c0358eF9Fd87E16488299Ef6e06F403B6";
  const paymasterAddress = "0xe5Eb4fB0F3312649Eb7b62fba66C9E26579D7208";
  const accountFactoryAddress = "0x940Cbb155161dc0C4aade27a4826a16Ed8ca0cb2";

  return {
    community: {
      name: guildSettings.guild?.name || "Token Bot Community",
      description: "Discord Token Bot Community",
      alias: "token-bot",
      primary_token: { address: token.address, chain_id: chainId },
      primary_account_factory: { address: accountFactoryAddress, chain_id: chainId },
      primary_card_manager: { address: cardManagerAddress, chain_id: chainId },
    },
    tokens: {
      [`${chainId}:${token.address}`]: {
        standard: "erc20", name: token.symbol, address: token.address,
        symbol: token.symbol, decimals: token.decimals, chain_id: chainId,
      },
    },
    accounts: {
      [`${chainId}:${accountFactoryAddress}`]: {
        chain_id: chainId, entrypoint_address: entrypointAddress,
        paymaster_address: paymasterAddress, account_factory_address: accountFactoryAddress,
        paymaster_type: "cw-safe",
      },
    },
    cards: {
      [`${chainId}:${cardManagerAddress}`]: {
        chain_id: chainId, instance_id: "cw-discord-1",
        address: cardManagerAddress, type: "safe",
      },
    },
    chains: {
      [chainId.toString()]: {
        id: chainId,
        node: {
          url: `https://${chainId}.engine.citizenwallet.xyz`,
          ws_url: `wss://${chainId}.engine.citizenwallet.xyz`,
        },
      },
    },
  };
}

function formatBalance(balance: bigint, decimals: number): string {
  const num = Number(formatUnits(balance, decimals));
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ── Step 1: /send @user → show token selection ─────────────────────────────

export default async function handleSendCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand() || !interaction.options) return;

  const recipientUser = interaction.options.getUser("user");
  if (!recipientUser) {
    await interaction.reply({ content: "❌ Please specify a user.", ephemeral: true });
    return;
  }

  if (recipientUser.id === userId) {
    await interaction.reply({ content: "❌ You cannot send tokens to yourself.", ephemeral: true });
    return;
  }

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings || guildSettings.tokens.length === 0) {
    await interaction.reply({ content: "❌ No tokens configured.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Get sender's address
    const senderAddress = await getAccountAddressFromDiscordUserId(userId);
    if (!senderAddress) {
      await interaction.editReply({ content: "❌ Could not find your account." });
      return;
    }

    // Fetch balances for all tokens
    const balances = new Map<number, bigint>();
    const tokenOptions: { label: string; description: string; value: string }[] = [];

    for (let i = 0; i < guildSettings.tokens.length; i++) {
      const token = guildSettings.tokens[i];
      try {
        const balance = await getBalance(
          token.chain as SupportedChain,
          token.address,
          senderAddress,
        );
        balances.set(i, balance);

        if (balance > 0n) {
          tokenOptions.push({
            label: `${token.symbol} — ${token.name}`,
            description: `Balance: ${formatBalance(balance, token.decimals)} ${token.symbol}`,
            value: String(i),
          });
        }
      } catch (err) {
        console.error(`Error fetching balance for ${token.symbol}:`, err);
      }
    }

    if (tokenOptions.length === 0) {
      await interaction.editReply({ content: "❌ You don't have any token balance to send." });
      return;
    }

    // Store state
    const state: SendState = {
      recipientId: recipientUser.id,
      recipientName: recipientUser.username,
      guildId,
      senderId: userId,
      senderAddress,
      balances,
    };
    sendStates.set(userId, state);

    // If only one token with balance, skip selection
    if (tokenOptions.length === 1) {
      const idx = Number(tokenOptions[0].value);
      state.tokenIndex = idx;
      state.token = guildSettings.tokens[idx];
      await showAmountPrompt(interaction, state);
      return;
    }

    // Show token selection
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("send_token_select")
      .setPlaceholder("Select a token to send")
      .addOptions(tokenOptions);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.editReply({
      content: `💸 Sending to <@${recipientUser.id}>\n\n**Select the token to send:**`,
      components: [row],
    });
  } catch (error) {
    console.error("Error in send command:", error);
    await interaction.editReply({
      content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ── Show amount prompt (modal) ──────────────────────────────────────────────

async function showAmountPrompt(interaction: any, state: SendState) {
  const token = state.token!;
  const balance = state.balances.get(state.tokenIndex!) ?? 0n;
  const balStr = formatBalance(balance, token.decimals);

  // Use a button to trigger a modal (modals can't be sent from editReply directly)
  const button = new ButtonBuilder()
    .setCustomId("send_amount_btn")
    .setLabel(`Enter amount of ${token.symbol} to send`)
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  const content = `💸 Sending **${token.symbol}** to <@${state.recipientId}>\n📊 Your balance: **${balStr} ${token.symbol}**\n\nClick below to enter the amount:`;

  if (interaction.editReply) {
    await interaction.editReply({ content, components: [row] });
  } else if (interaction.update) {
    await interaction.update({ content, components: [row] });
  }
}

// ── Handle interactions (token select, amount button, modal submit) ─────────

export async function handleSendInteraction(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  const state = sendStates.get(userId);
  if (!state) {
    if (interaction.isRepliable()) {
      await (interaction as any).reply({ content: "❌ Session expired. Please run /send again.", ephemeral: true });
    }
    return;
  }

  // ── Token selection ──
  if (interaction.isStringSelectMenu() && interaction.customId === "send_token_select") {
    const tokenIndex = Number(interaction.values[0]);
    const guildSettings = await loadGuildSettings(guildId);
    if (!guildSettings) return;

    state.tokenIndex = tokenIndex;
    state.token = guildSettings.tokens[tokenIndex];

    await showAmountPrompt(interaction, state);
    return;
  }

  // ── Amount button → show modal ──
  if (interaction.isButton() && interaction.customId === "send_amount_btn") {
    const token = state.token!;
    const balance = state.balances.get(state.tokenIndex!) ?? 0n;
    const balStr = formatBalance(balance, token.decimals);

    const modal = new ModalBuilder()
      .setCustomId("send_amount_modal")
      .setTitle(`Send ${token.symbol} to @${state.recipientName}`);

    const amountInput = new TextInputBuilder()
      .setCustomId("send_amount_input")
      .setLabel(`Amount (balance: ${balStr} ${token.symbol})`)
      .setPlaceholder("e.g. 10")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const messageInput = new TextInputBuilder()
      .setCustomId("send_message_input")
      .setLabel("Message (optional)")
      .setPlaceholder("e.g. Thanks for helping out!")
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput),
    );

    await interaction.showModal(modal);
    return;
  }

  // ── Modal submit → execute transfer ──
  if (interaction.isModalSubmit() && interaction.customId === "send_amount_modal") {
    const amountStr = interaction.fields.getTextInputValue("send_amount_input").trim();
    const message = interaction.fields.getTextInputValue("send_message_input")?.trim() || undefined;

    const amount = Number(amountStr);
    if (isNaN(amount) || amount <= 0) {
      await interaction.reply({ content: "❌ Invalid amount. Please enter a positive number.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const token = state.token!;
    const balance = state.balances.get(state.tokenIndex!) ?? 0n;
    const formattedAmount = parseUnits(amount.toFixed(token.decimals), token.decimals);

    if (balance < formattedAmount) {
      const balStr = formatBalance(balance, token.decimals);
      await interaction.editReply({
        content: `❌ Insufficient balance. You have ${balStr} ${token.symbol} but tried to send ${amount} ${token.symbol}.`,
      });
      sendStates.delete(userId);
      return;
    }

    const guildSettings = await loadGuildSettings(guildId);
    if (!guildSettings) {
      await interaction.editReply({ content: "❌ Settings not found." });
      return;
    }

    try {
      const chain = token.chain as SupportedChain;
      const chainId = ChainConfig[chain].id;
      const communityConfigData = buildCommunityConfig(guildSettings, token);
      const community = new CommunityConfig(communityConfigData);

      const senderHashedUserId = keccak256(toUtf8Bytes(state.senderId));
      const recipientHashedUserId = keccak256(toUtf8Bytes(state.recipientId));
      const recipientAddress = await getCardAddress(community, recipientHashedUserId);

      if (!recipientAddress) {
        await interaction.editReply({ content: "❌ Could not find recipient's account." });
        sendStates.delete(userId);
        return;
      }

      const privateKey = Deno.env.get("PRIVATE_KEY");
      if (!privateKey) {
        await interaction.editReply({ content: "❌ Bot configuration error: Private key not set." });
        sendStates.delete(userId);
        return;
      }

      const signer = new Wallet(privateKey);
      const signerAccountAddress = await getAccountAddress(community, signer.address);
      if (!signerAccountAddress) {
        await interaction.editReply({ content: "❌ Could not find bot's account address." });
        sendStates.delete(userId);
        return;
      }

      const bundler = new BundlerService(community);
      const transferCalldata = tokenTransferCallData(recipientAddress, formattedAmount);
      const calldata = callOnCardCallData(
        community, senderHashedUserId, token.address, BigInt(0), transferCalldata,
      );

      const userOpData: UserOpData = {
        topic: tokenTransferEventTopic,
        from: state.senderAddress,
        to: recipientAddress,
        value: formattedAmount.toString(),
      };

      let extraData: UserOpExtraData | undefined;
      if (message) extraData = { description: message };

      const hash = await bundler.call(
        signer,
        community.primarySafeCardConfig.address,
        signerAccountAddress,
        calldata,
        BigInt(0),
        userOpData,
        extraData,
      );

      const txUri = `ethereum:${chainId}:tx:${hash}` as URI;

      // Post to transactions channel
      if (guildSettings.channels?.transactions && interaction.guild) {
        try {
          const ch = await interaction.guild.channels.fetch(guildSettings.channels.transactions) as TextChannel;
          if (ch) {
            let msg = `💸 <@${userId}> sent ${amount.toLocaleString("en-US")} ${token.symbol} to <@${state.recipientId}>`;
            if (message) msg += `: ${message}`;
            await ch.send(msg);
          }
        } catch (err) {
          console.error("Error posting to transactions channel:", err);
        }
      }

      // Nostr annotation
      try {
        const nostr = Nostr.getInstance();
        await nostr.publishMetadata(txUri, {
          content: message || `Sent ${amount} ${token.symbol} to Discord user`,
          tags: [["t", "send"], ["t", "transfer"], ["amount", amount.toString()]],
        });
      } catch (err) {
        console.error("Error publishing Nostr:", err);
      }

      let reply = `✅ Sent **${amount.toLocaleString("en-US")} ${token.symbol}** to <@${state.recipientId}>`;
      if (message) reply += `\n📝 ${message}`;
      await interaction.editReply({ content: reply });
    } catch (error) {
      console.error("Error executing send:", error);
      await interaction.editReply({
        content: `❌ Failed to send: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    sendStates.delete(userId);
  }
}
