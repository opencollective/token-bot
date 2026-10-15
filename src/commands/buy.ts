/**
 * /buy [item] [description]: buy something with your own tokens (see src/lib/shop.ts).
 *
 * Shows your balance and the items as buttons (or just the chosen item); clicking one burns its
 * price from your account. Everything is ephemeral: only you see it, only you can click.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { loadGuildSettings } from "../lib/utils.ts";
import { checkBalance, executePurchase, findShopItem, itemLine, SHOP_ITEMS, shopToken, type ShopItem, tokens } from "../lib/shop.ts";
import { txUrlFor } from "../lib/mint.ts";

export const BUY_PREFIX = "buy:";
const INTENT_TTL_MS = 15 * 60 * 1000;

/** What /buy was run with, for the buttons (the description can be longer than a customId). */
const intents = new Map<string, { userId: string; guildId: string; description?: string; at: number }>();

function newIntent(userId: string, guildId: string, description?: string): string {
  const now = Date.now();
  for (const [id, i] of intents) if (now - i.at > INTENT_TTL_MS) intents.delete(id);
  const id = crypto.randomUUID().slice(0, 8);
  intents.set(id, { userId, guildId, description, at: now });
  return id;
}

export function buyButtons(intentId: string, items: ShopItem[], balance: number) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const item of items.slice(0, 4)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUY_PREFIX}${intentId}:${item.id}`)
        .setLabel(`Buy: ${itemLine(item)}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(balance < item.price),
    );
  }
  row.addComponents(new ButtonBuilder().setCustomId(`${BUY_PREFIX}${intentId}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Secondary));
  return row;
}

export async function handleBuyCommand(interaction: ChatInputCommandInteraction, userId: string, guildId: string) {
  const settings = await loadGuildSettings(guildId);
  const token = shopToken(settings);
  if (!token) {
    await interaction.reply({ content: "❌ No token to buy with is configured in this server.", flags: MessageFlags.Ephemeral });
    return;
  }
  const itemInput = interaction.options.getString("item");
  const item = itemInput ? findShopItem(itemInput) : undefined;
  if (itemInput && !item) {
    await interaction.reply({ content: `❌ Unknown item "${itemInput}".`, flags: MessageFlags.Ephemeral });
    return;
  }
  const description = interaction.options.getString("description")?.trim() || undefined;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const items = item ? [item] : SHOP_ITEMS;
  const check = await checkBalance(userId, token, items.reduce((a, b) => (a.price <= b.price ? a : b)));
  const lines = [
    `🛒 **Buy with your tokens**`,
    `Your balance: **${tokens(check.balance)}**`,
    "",
    ...items.map((i) => `• ${itemLine(i)}`),
  ];
  if (description) lines.push("", `📝 ${description}`);
  if (!check.ok) {
    lines.push("", `❌ ${check.message}`);
    await interaction.editReply({ content: lines.join("\n") });
    return;
  }
  lines.push("", "-# The price is burned from your account when you click.");
  await interaction.editReply({
    content: lines.join("\n"),
    components: [buyButtons(newIntent(userId, guildId, description), items, check.balance)],
  });
}

export async function handleBuyButton(interaction: ButtonInteraction) {
  const [intentId, choice] = interaction.customId.slice(BUY_PREFIX.length).split(":");
  const intent = intents.get(intentId);
  if (!intent || Date.now() - intent.at > INTENT_TTL_MS) {
    await interaction.update({ content: "⌛ This expired. Run /buy again.", components: [] });
    return;
  }
  if (interaction.user.id !== intent.userId) {
    await interaction.reply({ content: "This isn't yours.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (choice === "cancel") {
    intents.delete(intentId);
    await interaction.update({ content: "Cancelled. Nothing was bought.", components: [] });
    return;
  }
  const item = findShopItem(choice);
  const settings = await loadGuildSettings(intent.guildId);
  const token = shopToken(settings);
  if (!item || !settings || !token) {
    await interaction.update({ content: "❌ This item is no longer available.", components: [] });
    return;
  }
  // One click only: a second click on the same message finds no intent.
  intents.delete(intentId);
  await interaction.update({ content: `⏳ Buying a ${item.label} for ${tokens(item.price)}…`, components: [] });

  const member = interaction.member && "displayName" in interaction.member ? interaction.member : null;
  const result = await executePurchase({
    client: interaction.client,
    guildSettings: settings,
    token,
    item,
    buyer: { id: interaction.user.id, name: member?.displayName || interaction.user.globalName || interaction.user.username },
    description: intent.description,
    via: "command",
  });
  await interaction.editReply({
    content: result.ok
      ? `✅ You bought a **${item.label}** for ${tokens(item.price)}. New balance: ${tokens(result.balanceAfter)}.\n` +
        `[View transaction](<${txUrlFor(token, result.hash)}>)${result.reportUrl ? ` · [report](${result.reportUrl})` : ""}`
      : `❌ ${result.error}\nNothing was charged.`,
  });
}
