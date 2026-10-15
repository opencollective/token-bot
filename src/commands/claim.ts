/**
 * /claim amount reason [for] [category]: ask for tokens for a contribution, for yourself or for
 * the people mentioned in `for`. Posted in the token's transactions channel for a minter to approve
 * (see src/lib/claims.ts).
 */
import { AutocompleteInteraction, ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { createClaim, mentionedIds } from "../lib/claims.ts";
import { tokenCategories } from "../lib/tx-categories.ts";

export async function handleClaimCommand(interaction: ChatInputCommandInteraction, userId: string, guildId: string) {
  const forText = interaction.options.getString("for")?.trim();
  const recipientIds = forText ? mentionedIds(forText) : [];
  if (forText && recipientIds.length === 0) {
    await interaction.reply({ content: "❌ In `for`, mention the people with @ (e.g. @alain @leen), or leave it empty to claim for yourself.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { url } = await createClaim({
      client: interaction.client,
      guildId,
      requesterId: userId,
      recipientIds,
      amount: interaction.options.getNumber("amount", true),
      reason: interaction.options.getString("reason", true),
      category: interaction.options.getString("category") ?? undefined,
      via: "command",
    });
    await interaction.editReply({ content: `✅ Claim posted: ${url}\nA minter will approve it. You can withdraw it there with Reject.` });
  } catch (error) {
    await interaction.editReply({ content: `❌ ${error instanceof Error ? error.message : String(error)}` });
  }
}

export async function handleClaimAutocomplete(interaction: AutocompleteInteraction) {
  const q = interaction.options.getFocused().toLowerCase();
  await interaction.respond(
    tokenCategories()
      .filter((c) => c.slug !== "uncategorized" && (c.slug.includes(q) || c.label.toLowerCase().includes(q)))
      .slice(0, 25)
      .map((c) => ({ name: c.label, value: c.slug })),
  );
}
