import {
  AutocompleteInteraction,
  GuildMember,
  Interaction,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import { findTokenByInput, loadGuildSettings } from "../lib/utils.ts";
import {
  executeMint,
  formatMintResults,
  getMintableTokens,
  parseRecipients,
} from "../lib/mint.ts";

export { EMAIL_REGEX, parseRecipients, type Recipient } from "../lib/mint.ts";

// Check if user has permission to mint/burn (admin or mintRoleId)
export function hasTokenPermission(member: GuildMember, mintRoleId?: string): boolean {
  // Admins always have permission
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return true;
  }
  // Check if user has the mint role
  if (mintRoleId && member.roles.cache.has(mintRoleId)) {
    return true;
  }
  return false;
}

// Handle autocomplete for token selection
export async function handleMintAutocomplete(
  interaction: AutocompleteInteraction,
  guildId: string,
) {
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.respond([]);
    return;
  }

  const mintableTokens = getMintableTokens(guildSettings.tokens);
  const focused = interaction.options.getFocused().toLowerCase();

  const choices = mintableTokens
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

export default async function handleMintCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings || guildSettings.tokens.length === 0) {
    await interaction.reply({
      content: "❌ No tokens configured. Run `/edit-tokens` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member as GuildMember;

  const mintableTokens = getMintableTokens(guildSettings.tokens);

  if (mintableTokens.length === 0) {
    await interaction.reply({
      content:
        "❌ No mintable tokens configured. Add a token with `/edit-tokens` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get arguments
  const tokenSymbol = interaction.options.getString("token");
  const usersInput = interaction.options.getString("users", true);
  const amount = interaction.options.getNumber("amount", true);
  const description = interaction.options.getString("description") || undefined;

  // Find the token (default to only mintable token if not specified)
  const token = tokenSymbol
    ? findTokenByInput(mintableTokens, tokenSymbol)
    : mintableTokens.length === 1 ? mintableTokens[0] : null;
  if (!token) {
    const available = mintableTokens.map((t) => `\`${t.symbol}\``).join(", ");
    await interaction.reply({
      content: tokenSymbol
        ? `❌ Token \`${tokenSymbol}\` not found. Available: ${available}`
        : `❌ Multiple tokens available. Please specify one: ${available}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check permission using per-token minter role
  if (!hasTokenPermission(member, token.minterRoleId)) {
    await interaction.reply({
      content: "❌ You don't have permission to mint tokens.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Parse recipients (Discord mentions and/or email addresses)
  const recipients = parseRecipients(usersInput);
  if (recipients.length === 0) {
    await interaction.reply({
      content: "❌ No valid recipients found. Mention users with @username or enter an email address.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const results = await executeMint({
    client: interaction.client,
    guildSettings,
    token,
    recipients,
    amount,
    description,
    minterId: userId,
    source: { via: "command" },
  });

  await interaction.editReply({ content: formatMintResults(results, token, amount, description) });
}
