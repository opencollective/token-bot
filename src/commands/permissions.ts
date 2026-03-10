import {
  GuildMember,
  Interaction,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import { loadGuildSettings } from "../lib/utils.ts";
import type { Token } from "../types.ts";

// Get mintable tokens from settings
function getMintableTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.mintable === true);
}

// Get explorer URL for a token
function getExplorerUrl(chain: string, address: string): string {
  const explorers: Record<string, string> = {
    celo: "https://celoscan.io/token",
    gnosis: "https://gnosisscan.io/token",
    base: "https://basescan.org/token",
    base_sepolia: "https://sepolia.basescan.org/token",
    polygon: "https://polygonscan.com/token",
  };
  return `${explorers[chain] || explorers.base}/${address}`;
}

export default async function handlePermissionsCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    await interaction.editReply({
      content: "❌ No settings configured for this server.",
    });
    return;
  }

  const mintableTokens = getMintableTokens(guildSettings.tokens);
  if (mintableTokens.length === 0) {
    await interaction.editReply({
      content: "❌ No mintable tokens configured.",
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "❌ Could not access server." });
    return;
  }

  // Fetch all members once
  const members = await guild.members.fetch();
  const adminMembers = members.filter((m) =>
    m.permissions.has(PermissionsBitField.Flags.Administrator)
  );

  // Build per-token permission info
  const tokenSections: string[] = [];

  for (const token of mintableTokens) {
    const explorerUrl = getExplorerUrl(token.chain, token.address);
    let section = `**${token.name} (${token.symbol})** [[inspect]](<${explorerUrl}>)`;

    if (token.minterRoleId) {
      try {
        const role = await guild.roles.fetch(token.minterRoleId);
        if (role) {
          const roleMembers = members.filter((m) => m.roles.cache.has(token.minterRoleId!));
          if (roleMembers.size > 0) {
            const mentions = roleMembers.map((m) => `<@${m.id}>`).join(", ");
            section += `\n• <@&${token.minterRoleId}>: ${mentions}`;
          } else {
            section += `\n• <@&${token.minterRoleId}>: _no members assigned_`;
          }
        } else {
          section += `\n• ⚠️ Minter role not found (ID: ${token.minterRoleId})`;
        }
      } catch (error) {
        console.error("Error fetching minter role:", error);
        section += `\n• ⚠️ Could not fetch minter role`;
      }
    } else {
      section += `\n• _No minter role configured — only admins can mint/burn_`;
    }

    tokenSections.push(section);
  }

  const adminMentions = adminMembers.map((m) => `<@${m.id}>`).join(", ");
  let message = tokenSections.join("\n\n");
  if (adminMembers.size > 0) {
    message += `\n\n**Server administrators** (${adminMentions}) can always mint/burn all tokens.`;
  }

  await interaction.editReply({
    content: `**🔐 Token Permissions**\n\n${message}`,
  });
}
