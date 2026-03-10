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

  // Build token list
  const tokenLines = mintableTokens.map((t) => {
    const explorerUrl = getExplorerUrl(t.chain, t.address);
    return `• ${t.name} (${t.symbol}) [[inspect]](<${explorerUrl}>)`;
  });

  // Get users with mint permission
  const mintRoleId = guildSettings.mintRoleId;
  let permissionMessage = "";

  if (mintRoleId) {
    try {
      const guild = interaction.guild;
      if (guild) {
        const role = await guild.roles.fetch(mintRoleId);
        if (role) {
          // Fetch members with this role
          const members = await guild.members.fetch();
          const roleMembers = members.filter((m) => m.roles.cache.has(mintRoleId));
          const adminMembers = members.filter(
            (m) =>
              m.permissions.has(PermissionsBitField.Flags.Administrator) &&
              !roleMembers.has(m.id)
          );

          const roleMemberMentions = roleMembers.map((m) => `<@${m.id}>`).join(", ");
          const adminMentions = adminMembers.map((m) => `<@${m.id}>`).join(", ");

          if (roleMembers.size > 0) {
            permissionMessage = `**People with the ${role.name} role** (${roleMemberMentions}) can mint/burn the following tokens:\n${tokenLines.join("\n")}`;
          } else {
            permissionMessage = `**No users currently have the ${role.name} role.**\n\nThe following tokens are configured for minting:\n${tokenLines.join("\n")}`;
          }

          if (adminMembers.size > 0) {
            permissionMessage += `\n\n**Server administrators** (${adminMentions}) can also mint/burn tokens.`;
          }
        } else {
          permissionMessage = `⚠️ Mint role (ID: ${mintRoleId}) not found.\n\nOnly server administrators can mint/burn tokens:\n${tokenLines.join("\n")}`;
        }
      }
    } catch (error) {
      console.error("Error fetching role members:", error);
      permissionMessage = `⚠️ Could not fetch role members.\n\nTokens configured for minting:\n${tokenLines.join("\n")}`;
    }
  } else {
    // No mint role configured, only admins can mint
    try {
      const guild = interaction.guild;
      if (guild) {
        const members = await guild.members.fetch();
        const adminMembers = members.filter((m) =>
          m.permissions.has(PermissionsBitField.Flags.Administrator)
        );
        const adminMentions = adminMembers.map((m) => `<@${m.id}>`).join(", ");

        permissionMessage = `**No mint role configured.** Only server administrators (${adminMentions}) can mint/burn the following tokens:\n${tokenLines.join("\n")}\n\nTo configure a mint role, add \`mintRoleId\` to your server settings.`;
      }
    } catch (error) {
      console.error("Error fetching admin members:", error);
      permissionMessage = `**No mint role configured.** Only server administrators can mint/burn the following tokens:\n${tokenLines.join("\n")}`;
    }
  }

  await interaction.editReply({
    content: `**🔐 Token Permissions**\n\n${permissionMessage}`,
  });
}
