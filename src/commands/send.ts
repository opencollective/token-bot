import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  StringSelectMenuBuilder,
  TextChannel,
} from "discord.js";
import { loadGuildSettings } from "../lib/utils.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import {
  BundlerService,
  CommunityConfig,
  callOnCardCallData,
  getAccountAddress,
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

// ── State ───────────────────────────────────────────────────────────────────

interface SendState {
  recipientId: string;
  recipientName: string;
  guildId: string;
  senderId: string;
  senderAddress: string;
  amount: number;
  description?: string;
  tokenIndex?: number;
  token?: Token;
  balances: Map<number, bigint>;
}

export const sendStates = new Map<string, SendState>();

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildCommunityConfig(guildSettings: GuildSettings, token: Token): any {
  const chain = token.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;
  return {
    community: {
      name: guildSettings.guild?.name || "Token Bot Community",
      description: "Discord Token Bot Community", alias: "token-bot",
      primary_token: { address: token.address, chain_id: chainId },
      primary_account_factory: { address: "0x940Cbb155161dc0C4aade27a4826a16Ed8ca0cb2", chain_id: chainId },
      primary_card_manager: { address: "0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28", chain_id: chainId },
    },
    tokens: {
      [`${chainId}:${token.address}`]: {
        standard: "erc20", name: token.symbol, address: token.address,
        symbol: token.symbol, decimals: token.decimals, chain_id: chainId,
      },
    },
    accounts: {
      [`${chainId}:0x940Cbb155161dc0C4aade27a4826a16Ed8ca0cb2`]: {
        chain_id: chainId, entrypoint_address: "0x7079253c0358eF9Fd87E16488299Ef6e06F403B6",
        paymaster_address: "0xe5Eb4fB0F3312649Eb7b62fba66C9E26579D7208",
        account_factory_address: "0x940Cbb155161dc0C4aade27a4826a16Ed8ca0cb2", paymaster_type: "cw-safe",
      },
    },
    cards: {
      [`${chainId}:0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28`]: {
        chain_id: chainId, instance_id: "cw-discord-1",
        address: "0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28", type: "safe",
      },
    },
    chains: {
      [chainId.toString()]: {
        id: chainId,
        node: { url: `https://${chainId}.engine.citizenwallet.xyz`, ws_url: `wss://${chainId}.engine.citizenwallet.xyz` },
      },
    },
  };
}

function fmtBal(balance: bigint, decimals: number): string {
  const num = Number(formatUnits(balance, decimals));
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ── Step 1: /send @user amount description ──────────────────────────────────

export default async function handleSendCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand() || !interaction.options) return;

  const recipientUser = interaction.options.getUser("user");
  const amount = interaction.options.getNumber("amount");
  const description = interaction.options.getString("description") || undefined;

  if (!recipientUser || !amount) {
    await interaction.reply({ content: "❌ Missing required options.", ephemeral: true });
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
    const senderAddress = await getAccountAddressFromDiscordUserId(userId);
    if (!senderAddress) {
      await interaction.editReply({ content: "❌ Could not find your account." });
      return;
    }

    // Fetch balances for all tokens
    const balances = new Map<number, bigint>();
    const tokensWithBalance: number[] = [];

    for (let i = 0; i < guildSettings.tokens.length; i++) {
      const token = guildSettings.tokens[i];
      try {
        const balance = await getBalance(token.chain as SupportedChain, token.address, senderAddress);
        balances.set(i, balance);
        const needed = parseUnits(amount.toFixed(token.decimals), token.decimals);
        if (balance >= needed) tokensWithBalance.push(i);
      } catch (err) {
        console.error(`Error fetching balance for ${token.symbol}:`, err);
      }
    }

    if (tokensWithBalance.length === 0) {
      // Show what they have
      const balLines = guildSettings.tokens
        .map((t, i) => {
          const b = balances.get(i) ?? 0n;
          return `  ${t.symbol}: ${fmtBal(b, t.decimals)}`;
        })
        .join("\n");
      await interaction.editReply({
        content: `❌ Insufficient balance to send ${amount} tokens.\n\nYour balances:\n${balLines}`,
      });
      return;
    }

    const state: SendState = {
      recipientId: recipientUser.id,
      recipientName: recipientUser.username,
      guildId, senderId: userId, senderAddress,
      amount, description, balances,
    };
    sendStates.set(userId, state);

    // If only one token has sufficient balance → go straight to confirmation
    if (tokensWithBalance.length === 1) {
      const idx = tokensWithBalance[0];
      state.tokenIndex = idx;
      state.token = guildSettings.tokens[idx];
      await showConfirmation(interaction, state);
      return;
    }

    // Multiple tokens → show picker
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("send_token_select")
      .setPlaceholder("Select which token to send")
      .addOptions(
        tokensWithBalance.map((i) => {
          const t = guildSettings.tokens[i];
          const b = balances.get(i) ?? 0n;
          return {
            label: `${t.symbol} — ${t.name}`,
            description: `Balance: ${fmtBal(b, t.decimals)} ${t.symbol}`,
            value: String(i),
          };
        }),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.editReply({
      content: `💸 Sending **${amount}** to <@${recipientUser.id}>\n\nYou have sufficient balance in multiple tokens. **Which one?**`,
      components: [row],
    });
  } catch (error) {
    console.error("Error in send command:", error);
    await interaction.editReply({
      content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

// ── Confirmation step ───────────────────────────────────────────────────────

async function showConfirmation(interaction: any, state: SendState) {
  const token = state.token!;
  const balance = state.balances.get(state.tokenIndex!) ?? 0n;

  let msg = `💸 **Send ${state.amount.toLocaleString("en-US")} ${token.symbol}** to <@${state.recipientId}>`;
  if (state.description) msg += `\n📝 ${state.description}`;
  msg += `\n\nYour balance: ${fmtBal(balance, token.decimals)} ${token.symbol}`;

  const confirmBtn = new ButtonBuilder()
    .setCustomId("send_confirm")
    .setLabel("Confirm")
    .setStyle(ButtonStyle.Success);

  const cancelBtn = new ButtonBuilder()
    .setCustomId("send_cancel")
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, cancelBtn);

  if (interaction.isStringSelectMenu?.() || interaction.isButton?.()) {
    await interaction.update({ content: msg, components: [row] });
  } else {
    await interaction.editReply({ content: msg, components: [row] });
  }
}

// ── Handle interactions ─────────────────────────────────────────────────────

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

  // ── Token selection → show confirmation ──
  if (interaction.isStringSelectMenu() && interaction.customId === "send_token_select") {
    const tokenIndex = Number(interaction.values[0]);
    const guildSettings = await loadGuildSettings(guildId);
    if (!guildSettings) return;

    state.tokenIndex = tokenIndex;
    state.token = guildSettings.tokens[tokenIndex];
    await showConfirmation(interaction, state);
    return;
  }

  // ── Cancel ──
  if (interaction.isButton() && interaction.customId === "send_cancel") {
    sendStates.delete(userId);
    await interaction.update({ content: "❌ Send cancelled.", components: [] });
    return;
  }

  // ── Confirm → execute transfer ──
  if (interaction.isButton() && interaction.customId === "send_confirm") {
    await interaction.update({ content: "⏳ Sending...", components: [] });

    const token = state.token!;
    const guildSettings = await loadGuildSettings(guildId);
    if (!guildSettings) {
      await interaction.editReply({ content: "❌ Settings not found." });
      sendStates.delete(userId);
      return;
    }

    try {
      const chain = token.chain as SupportedChain;
      const chainId = ChainConfig[chain].id;
      const community = new CommunityConfig(buildCommunityConfig(guildSettings, token));

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

      const formattedAmount = parseUnits(state.amount.toFixed(token.decimals), token.decimals);
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
      if (state.description) extraData = { description: state.description };

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
      if (guildSettings.channels?.transactions) {
        try {
          const ch = await interaction.client.channels.fetch(guildSettings.channels.transactions) as TextChannel;
          if (ch) {
            let msg = `💸 <@${userId}> sent ${state.amount.toLocaleString("en-US")} ${token.symbol} to <@${state.recipientId}>`;
            if (state.description) msg += `: ${state.description}`;
            await ch.send(msg);
          }
        } catch (err) {
          console.error("Error posting to transactions channel:", err);
        }
      }

      // Nostr
      try {
        const nostr = Nostr.getInstance();
        await nostr.publishMetadata(txUri, {
          content: state.description || `Sent ${state.amount} ${token.symbol} to Discord user`,
          tags: [["t", "send"], ["t", "transfer"], ["amount", state.amount.toString()]],
        });
      } catch (err) {
        console.error("Error publishing Nostr:", err);
      }

      let reply = `✅ Sent **${state.amount.toLocaleString("en-US")} ${token.symbol}** to <@${state.recipientId}>`;
      if (state.description) reply += `\n📝 ${state.description}`;
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
