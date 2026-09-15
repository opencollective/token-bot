// "Mint tokens" message context menu (right-click a message → Apps → Mint tokens).
// Pre-fills the recipients from the message author + mentions, then asks the minter
// for the amount and a description in a modal.
import {
  ActionRowBuilder,
  GuildMember,
  MessageContextMenuCommandInteraction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { findTokenByInput, loadGuildSettings } from "../lib/utils.ts";
import {
  announceMintOnMessage,
  buildMessageUrl,
  executeMint,
  formatMintResults,
  getMintableTokens,
  parseRecipients,
  recipientsFromMessage,
} from "../lib/mint.ts";
import { hasTokenPermission } from "./mint.ts";
import type { Token } from "../types.ts";

export const MINT_CONTEXT_COMMAND_NAME = "Mint tokens";
export const MINT_CONTEXT_MODAL_ID = "mint_ctx_modal";

type MintContextState = {
  guildId: string;
  channelId: string;
  messageId: string;
  messageUrl: string;
  tokenSymbol?: string; // Set when only one token is available (no token field in the modal)
  createdAt: number;
};

export const mintContextStates = new Map<string, MintContextState>();

const STATE_TTL_MS = 15 * 60 * 1000;
const DESCRIPTION_PREFILL_MAX = 400;

export function tokensUserCanMint(member: GuildMember, tokens: Token[]): Token[] {
  return getMintableTokens(tokens).filter((t) => hasTokenPermission(member, t.minterRoleId));
}

export async function handleMintContextMenu(
  interaction: MessageContextMenuCommandInteraction,
  userId: string,
  guildId: string,
) {
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings || guildSettings.tokens.length === 0) {
    await interaction.reply({
      content: "❌ No tokens configured. Run `/edit-tokens` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member as GuildMember;
  const tokens = tokensUserCanMint(member, guildSettings.tokens);
  if (tokens.length === 0) {
    await interaction.reply({
      content: "❌ You don't have permission to mint tokens.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const message = interaction.targetMessage;
  const recipients = recipientsFromMessage(message);
  if (recipients.length === 0) {
    await interaction.reply({
      content: "❌ No recipients found on this message (author and mentions are bots).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const state: MintContextState = {
    guildId,
    channelId: message.channelId,
    messageId: message.id,
    messageUrl: buildMessageUrl(guildId, message.channelId, message.id),
    tokenSymbol: tokens.length === 1 ? tokens[0].symbol : undefined,
    createdAt: Date.now(),
  };
  mintContextStates.set(userId, state);

  const defaultAmount = tokens.length === 1 ? tokens[0].mintReactionAmount ?? 1 : 1;
  const prefillDescription = (message.content || "").slice(0, DESCRIPTION_PREFILL_MAX);

  const recipientsInput = new TextInputBuilder()
    .setCustomId("recipients")
    .setLabel("Recipients (@mentions or emails)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(4000)
    .setValue(recipients.map((r) => r.label).join(" ").slice(0, 4000));

  const amountInput = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("Amount per recipient")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20)
    .setValue(String(defaultAmount));

  const descriptionInput = new TextInputBuilder()
    .setCustomId("description")
    .setLabel("Description (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);
  if (prefillDescription) descriptionInput.setValue(prefillDescription);

  const modal = new ModalBuilder()
    .setCustomId(MINT_CONTEXT_MODAL_ID)
    .setTitle(tokens.length === 1 ? `Mint ${tokens[0].symbol}` : "Mint tokens")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(recipientsInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput),
    );

  if (tokens.length > 1) {
    const tokenInput = new TextInputBuilder()
      .setCustomId("token")
      .setLabel(`Token (${tokens.map((t) => t.symbol).join(", ")})`.slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(50)
      .setValue(tokens[0].symbol);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(tokenInput));
  }

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput));

  await interaction.showModal(modal);
}

export async function handleMintContextModal(
  interaction: ModalSubmitInteraction,
  userId: string,
  guildId: string,
) {
  const state = mintContextStates.get(userId);
  mintContextStates.delete(userId);
  if (!state || state.guildId !== guildId || Date.now() - state.createdAt > STATE_TTL_MS) {
    await interaction.reply({
      content: "⚠️ Session expired. Right-click the message and try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.reply({ content: "❌ Settings not found.", flags: MessageFlags.Ephemeral });
    return;
  }

  const member = interaction.member as GuildMember;
  const allowed = tokensUserCanMint(member, guildSettings.tokens);
  const tokenSymbol = state.tokenSymbol ??
    (interaction.fields.getTextInputValue("token") || "").trim();
  const token = findTokenByInput(allowed, tokenSymbol);
  if (!token) {
    const available = allowed.map((t) => `\`${t.symbol}\``).join(", ") || "none";
    await interaction.reply({
      content: `❌ Token \`${tokenSymbol}\` not found or not allowed. Available: ${available}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const amount = parseFloat(interaction.fields.getTextInputValue("amount").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) {
    await interaction.reply({
      content: "❌ Amount must be a positive number.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const recipients = parseRecipients(interaction.fields.getTextInputValue("recipients"));
  if (recipients.length === 0) {
    await interaction.reply({
      content: "❌ No valid recipients found. Mention users with @username or enter an email address.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const description = interaction.fields.getTextInputValue("description")?.trim() || undefined;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const results = await executeMint({
    client: interaction.client,
    guildSettings,
    token,
    recipients,
    amount,
    description,
    minterId: userId,
    source: { via: "context-menu", messageUrl: state.messageUrl },
  });

  await interaction.editReply({ content: formatMintResults(results, token, amount, description) });

  // Acknowledge publicly on the original message (best effort)
  try {
    const channel = await interaction.client.channels.fetch(state.channelId);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(state.messageId);
      await announceMintOnMessage(message, results, token, amount, userId);
    }
  } catch (error) {
    console.error("Error acknowledging context-menu mint:", error);
  }
}
