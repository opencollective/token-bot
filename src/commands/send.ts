import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  Interaction,
  StringSelectMenuBuilder,
} from "discord.js";
import { findTokenByInput, loadGuildSettings } from "../lib/utils.ts";
import { formatUnits, parseUnits } from "@wevm/viem";
import { getBalance, SupportedChain } from "../lib/blockchain.ts";
import { getAccountAddressForToken } from "../lib/citizenwallet.ts";
import { executeSend } from "../lib/send.ts";
import type { Token } from "../types.ts";

// ── State ───────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SendState {
  recipientId: string; // Discord user ID or email address
  recipientAccountId: string; // "discord:id" or "email:addr"
  recipientName: string;
  recipientLabel: string; // "<@id>" or "email"
  guildId: string;
  senderId: string;
  senderAddress: string; // Address for the selected token's chain
  amount: number;
  description?: string;
  tokenIndex?: number;
  token?: Token;
  balances: Map<number, bigint>;
  addresses: Map<number, string>; // tokenIndex → resolved address per chain
}

export const sendStates = new Map<string, SendState>();

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtBal(balance: bigint, decimals: number): string {
  const num = Number(formatUnits(balance, decimals));
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ── Autocomplete ────────────────────────────────────────────────────────────

export async function handleSendAutocomplete(
  interaction: AutocompleteInteraction,
  guildId: string,
) {
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused().toLowerCase();

  const choices = guildSettings.tokens
    .filter(
      (t) =>
        t.symbol.toLowerCase().includes(focused) ||
        t.name.toLowerCase().includes(focused),
    )
    .map((t) => ({
      name: `${t.symbol} (${t.name})`,
      value: t.symbol,
    }))
    .slice(0, 25);

  await interaction.respond(choices);
}

// ── Step 1: /send @user amount description ──────────────────────────────────

export default async function handleSendCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand() || !interaction.options) return;

  const recipientInput = interaction.options.getString("recipient", true);
  const amount = interaction.options.getNumber("amount");
  const tokenSymbol = interaction.options.getString("token");
  const description = interaction.options.getString("description") || undefined;

  if (!amount) {
    await interaction.reply({ content: "❌ Missing required options.", ephemeral: true });
    return;
  }

  // Determine recipient (Discord mention or email)
  let recipientId: string;
  let recipientAccountId: string;
  let recipientName: string;
  let recipientLabel: string;

  const trimmed = recipientInput.trim();
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    const mentionedId = mentionMatch[1];
    if (mentionedId === userId) {
      await interaction.reply({ content: "❌ You cannot send tokens to yourself.", ephemeral: true });
      return;
    }
    const mentionedUser = interaction.options.resolved?.users?.get(mentionedId);
    recipientId = mentionedId;
    recipientAccountId = `discord:${mentionedId}`;
    recipientName = mentionedUser?.username ?? mentionedId;
    recipientLabel = `<@${mentionedId}>`;
  } else {
    const email = trimmed.toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      await interaction.reply({ content: "❌ Recipient must be a @mention or email address.", ephemeral: true });
      return;
    }
    recipientId = email;
    recipientAccountId = `email:${email}`;
    recipientName = email;
    recipientLabel = email;
  }

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings || guildSettings.tokens.length === 0) {
    await interaction.reply({ content: "❌ No tokens configured.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Fetch balances for all tokens (each may resolve a different address per chain)
    const balances = new Map<number, bigint>();
    const addresses = new Map<number, string>(); // tokenIndex → resolved address
    const tokensWithBalance: number[] = [];

    for (let i = 0; i < guildSettings.tokens.length; i++) {
      const token = guildSettings.tokens[i];
      try {
        const address = await getAccountAddressForToken(userId, token);
        if (!address) {
          console.log(`[send] Could not resolve address for ${token.symbol} (${token.chain})`);
          continue;
        }
        addresses.set(i, address);
        console.log(`[send] ${token.symbol} (${token.chain}) address: ${address}`);
        const balance = await getBalance(token.chain as SupportedChain, token.address, address);
        console.log(`[send] ${token.symbol} balance: ${balance.toString()}`);
        balances.set(i, balance);
        if (balance > 0n) tokensWithBalance.push(i);
      } catch (err) {
        console.error(`[send] Error fetching balance for ${token.symbol} (${token.chain}):`, err);
      }
    }
    console.log(`[send] Tokens with positive balance: ${tokensWithBalance.map(i => guildSettings.tokens[i].symbol).join(", ") || "none"}`);

    const state: SendState = {
      recipientId,
      recipientAccountId,
      recipientName,
      recipientLabel,
      guildId, senderId: userId, senderAddress: "",
      amount, description, balances, addresses,
    };
    sendStates.set(userId, state);

    // If a token was specified via the command option, use it directly
    if (tokenSymbol) {
      const matched = findTokenByInput(guildSettings.tokens, tokenSymbol);
      const idx = matched ? guildSettings.tokens.indexOf(matched) : -1;
      if (idx === -1) {
        const available = guildSettings.tokens.map((t) => t.symbol).join(", ");
        await interaction.editReply({
          content: `❌ Token \`${tokenSymbol}\` not found. Available: ${available}`,
        });
        sendStates.delete(userId);
        return;
      }
      const address = addresses.get(idx);
      const balance = balances.get(idx) ?? 0n;
      if (!address || balance <= 0n) {
        await interaction.editReply({
          content: `❌ You don't have any ${guildSettings.tokens[idx].symbol} balance.`,
        });
        sendStates.delete(userId);
        return;
      }
      state.tokenIndex = idx;
      state.token = guildSettings.tokens[idx];
      state.senderAddress = address;
      await showConfirmation(interaction, state);
      return;
    }

    if (tokensWithBalance.length === 0) {
      await interaction.editReply({
        content: `❌ You don't have any token balance.`,
      });
      sendStates.delete(userId);
      return;
    }

    // If only one token has sufficient balance → go straight to confirmation
    if (tokensWithBalance.length === 1) {
      const idx = tokensWithBalance[0];
      state.tokenIndex = idx;
      state.token = guildSettings.tokens[idx];
      state.senderAddress = addresses.get(idx) || "";
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
      content: `💸 Sending **${amount}** to ${recipientLabel}\n\nYou have sufficient balance in multiple tokens. **Which one?**`,
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

  let msg = `💸 **Send ${state.amount.toLocaleString("en-US")} ${token.symbol}** to ${state.recipientLabel}`;
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
    state.senderAddress = state.addresses.get(tokenIndex) || "";
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
    await interaction.update({ content: "⏳ Checking balance...", components: [] });

    const token = state.token!;

    // Re-check balance before executing (use token-specific address)
    const senderAddr = state.senderAddress || state.addresses.get(state.tokenIndex!) || "";
    try {
      const currentBalance = await getBalance(token.chain as SupportedChain, token.address, senderAddr);
      const needed = parseUnits(state.amount.toFixed(token.decimals), token.decimals);
      if (currentBalance < needed) {
        await interaction.editReply({
          content: `❌ Insufficient ${token.symbol} balance. You have ${fmtBal(currentBalance, token.decimals)} but need ${state.amount}.`,
        });
        sendStates.delete(userId);
        return;
      }
    } catch (err) {
      await interaction.editReply({ content: `❌ Could not verify balance: ${err}` });
      sendStates.delete(userId);
      return;
    }

    await interaction.editReply({ content: "⏳ Sending..." });

    const guildSettings = await loadGuildSettings(guildId);
    if (!guildSettings) {
      await interaction.editReply({ content: "❌ Settings not found." });
      sendStates.delete(userId);
      return;
    }

    const [result] = await executeSend({
      client: interaction.client,
      guildSettings,
      token,
      senderId: state.senderId,
      senderAddress: senderAddr,
      recipients: [{
        type: state.recipientAccountId.startsWith("email:") ? "email" : "discord",
        id: state.recipientId,
        label: state.recipientLabel,
        accountId: state.recipientAccountId,
      }],
      amount: state.amount,
      description: state.description,
      source: { via: "command" },
    });

    if (result?.success) {
      let reply = `✅ Sent **${state.amount.toLocaleString("en-US")} ${token.symbol}** to ${state.recipientLabel}`;
      if (state.description) reply += `\n📝 ${state.description}`;
      await interaction.editReply({ content: reply });
    } else {
      await interaction.editReply({ content: `❌ ${result?.error ?? "Unknown error"}` });
    }

    sendStates.delete(userId);
  }
}
