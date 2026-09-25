// "Mint tokens" message context menu (right-click a message → Apps → Mint tokens).
// Opens a modal with:
//   - the message author + mentioned people as pre-checked checkboxes (uncheck to skip someone)
//   - a user picker with search to add other people
//   - the amount per recipient
//   - a radio group to pick the token (only when the minter can mint more than one)
//   - a description prefilled from the message, with mentions shown as @names
import {
  CheckboxGroupBuilder,
  CheckboxGroupOptionBuilder,
  GuildMember,
  LabelBuilder,
  Message,
  MessageContextMenuCommandInteraction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  RadioGroupBuilder,
  RadioGroupOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from "discord.js";
import { loadGuildSettings } from "../lib/utils.ts";
import {
  announceMintOnMessage,
  buildMessageUrl,
  executeMint,
  formatMintResults,
  getMintableTokens,
  type Recipient,
  recipientsFromMessage,
} from "../lib/mint.ts";
import { hasTokenPermission } from "./mint.ts";
import type { Token } from "../types.ts";

export const MINT_CONTEXT_COMMAND_NAME = "Mint tokens";
export const MINT_CONTEXT_MODAL_ID = "mint_ctx_modal";

const FIELD_RECIPIENTS = "recipients"; // checkbox group (≤ 10 people) or user select (> 10)
const FIELD_EXTRA = "extra_recipients"; // user select to add more people
const FIELD_AMOUNT = "amount";
const FIELD_TOKEN = "token"; // radio group
const FIELD_DESCRIPTION = "description";

const MAX_CHECKBOXES = 10; // Discord limit for a checkbox group
const MAX_USER_SELECT = 25; // Discord limit for a user select

type MintContextState = {
  guildId: string;
  channelId: string;
  messageId: string;
  messageUrl: string;
  tokenSymbols: string[]; // Tokens offered in the modal, in order
  recipientsAsCheckboxes: boolean;
  createdAt: number;
};

export const mintContextStates = new Map<string, MintContextState>();

const STATE_TTL_MS = 15 * 60 * 1000;
const DESCRIPTION_PREFILL_MAX = 400;

export function tokensUserCanMint(member: GuildMember, tokens: Token[]): Token[] {
  return getMintableTokens(tokens).filter((t) => hasTokenPermission(member, t.minterRoleId));
}

// Replace raw <@id> mentions with @Name so the prefilled description is readable.
export function mentionsToNames(text: string, names: Map<string, string>): string {
  return text.replace(/<@!?(\d+)>/g, (raw, id) => (names.has(id) ? `@${names.get(id)}` : raw));
}

// Merge the checked people and the extra picked people, keeping order and dropping duplicates/bots.
export function mergeRecipientIds(
  checked: readonly string[],
  extra: { id: string; bot?: boolean }[],
): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ type: "discord", id, label: `<@${id}>`, accountId: `discord:${id}` });
  };
  checked.forEach(add);
  extra.filter((u) => !u.bot).forEach((u) => add(u.id));
  return out;
}

// Display names for everyone the message refers to (server nickname when available).
function namesFromMessage(message: Message): Map<string, string> {
  const names = new Map<string, string>();
  const nameOf = (user: { id: string; username: string; globalName?: string | null }) =>
    message.guild?.members.cache.get(user.id)?.displayName ?? user.globalName ?? user.username;
  names.set(message.author.id, message.member?.displayName ?? nameOf(message.author));
  for (const user of message.mentions.users.values()) {
    names.set(user.id, message.mentions.members?.get(user.id)?.displayName ?? nameOf(user));
  }
  return names;
}

// Build the "Mint tokens" modal. Pure so it can be validated in tests.
export function buildMintModal(
  tokens: Token[],
  recipients: Recipient[],
  names: Map<string, string>,
  messageContent: string,
): ModalBuilder {
  const asCheckboxes = recipients.length > 0 && recipients.length <= MAX_CHECKBOXES;
  const modal = new ModalBuilder()
    .setCustomId(MINT_CONTEXT_MODAL_ID)
    .setTitle(tokens.length === 1 ? `Mint ${tokens[0].symbol}` : "Mint tokens");

  // Recipients: checkboxes for the people in the message (all checked), plus a picker to add others.
  if (asCheckboxes) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel("Recipients")
        .setDescription("Uncheck anyone who shouldn't receive tokens")
        .setCheckboxGroupComponent(
          new CheckboxGroupBuilder()
            .setCustomId(FIELD_RECIPIENTS)
            .setRequired(false)
            .setMinValues(0)
            .setMaxValues(recipients.length)
            .setOptions(
              recipients.map((r, i) =>
                new CheckboxGroupOptionBuilder()
                  .setLabel(`@${names.get(r.id) ?? r.id}`.slice(0, 100))
                  .setValue(r.id)
                  .setDescription(i === 0 ? "Message author" : "Mentioned")
                  .setDefault(true)
              ),
            ),
        ),
    );
  }

  const picker = new UserSelectMenuBuilder()
    .setCustomId(asCheckboxes ? FIELD_EXTRA : FIELD_RECIPIENTS)
    .setRequired(!asCheckboxes)
    .setMinValues(asCheckboxes ? 0 : 1)
    .setMaxValues(MAX_USER_SELECT)
    .setPlaceholder("Search people…");
  if (!asCheckboxes && recipients.length > 0) picker.setDefaultUsers(recipients.map((r) => r.id));
  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel(asCheckboxes ? "Add other people (optional)" : "Recipients")
      .setUserSelectMenuComponent(picker),
  );

  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel("Amount per recipient")
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId(FIELD_AMOUNT)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
          .setValue(String(tokens[0].mintReactionAmount ?? 1)),
      ),
  );

  if (tokens.length > 1) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel("Token")
        .setRadioGroupComponent(
          new RadioGroupBuilder()
            .setCustomId(FIELD_TOKEN)
            .setRequired(true)
            .setOptions(
              tokens.map((t, i) =>
                new RadioGroupOptionBuilder()
                  .setLabel(t.symbol)
                  .setValue(t.symbol)
                  .setDescription(t.name.slice(0, 100))
                  .setDefault(i === 0)
              ),
            ),
        ),
    );
  }

  const description = new TextInputBuilder()
    .setCustomId(FIELD_DESCRIPTION)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);
  const prefill = mentionsToNames(messageContent, names).slice(0, DESCRIPTION_PREFILL_MAX);
  if (prefill) description.setValue(prefill);
  modal.addLabelComponents(
    new LabelBuilder().setLabel("Description (optional)").setTextInputComponent(description),
  );

  return modal;
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
  const tokens = tokensUserCanMint(member, guildSettings.tokens).slice(0, 10);
  if (tokens.length === 0) {
    await interaction.reply({
      content: "❌ You don't have permission to mint tokens.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const message = interaction.targetMessage;
  const recipients = recipientsFromMessage(message).slice(0, MAX_USER_SELECT);
  const names = namesFromMessage(message);
  const asCheckboxes = recipients.length > 0 && recipients.length <= MAX_CHECKBOXES;

  mintContextStates.set(userId, {
    guildId,
    channelId: message.channelId,
    messageId: message.id,
    messageUrl: buildMessageUrl(guildId, message.channelId, message.id),
    tokenSymbols: tokens.map((t) => t.symbol),
    recipientsAsCheckboxes: asCheckboxes,
    createdAt: Date.now(),
  });

  const modal = buildMintModal(tokens, recipients, names, message.content || "");
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
  const tokenSymbol = state.tokenSymbols.length > 1
    ? interaction.fields.getRadioGroup(FIELD_TOKEN)
    : state.tokenSymbols[0];
  const token = allowed.find((t) => t.symbol === tokenSymbol);
  if (!token) {
    await interaction.reply({
      content: `❌ You can't mint \`${tokenSymbol ?? "?"}\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const amount = parseFloat(interaction.fields.getTextInputValue(FIELD_AMOUNT).replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) {
    await interaction.reply({
      content: "❌ Amount must be a positive number.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const checked = state.recipientsAsCheckboxes
    ? interaction.fields.getCheckboxGroup(FIELD_RECIPIENTS) ?? []
    : [];
  const picked = interaction.fields.getSelectedUsers(
    state.recipientsAsCheckboxes ? FIELD_EXTRA : FIELD_RECIPIENTS,
  );
  const recipients = mergeRecipientIds(checked, picked ? [...picked.values()] : []);
  if (recipients.length === 0) {
    await interaction.reply({
      content: "❌ No recipients selected.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const description = interaction.fields.getTextInputValue(FIELD_DESCRIPTION)?.trim() || undefined;

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
