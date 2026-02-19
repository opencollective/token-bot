import { Interaction } from "discord.js";
import { getBalance, SupportedChain } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { getAccountAddressForToken } from "../lib/citizenwallet.ts";
import { formatUnits } from "@wevm/viem";

export default async function handleBalanceCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  if (!interaction.isChatInputCommand() || !interaction.options) {
    return;
  }

  const targetUser = interaction.options.getUser("user");
  const targetUserId = targetUser?.id || userId;
  const isOwnBalance = targetUserId === userId;

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings || guildSettings.tokens.length === 0) {
    await interaction.reply({
      content: "❌ No tokens configured. Run `/add-token` first.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Fetch balances for all tokens (each may resolve a different address per chain)
    const balanceLines: string[] = [];
    for (const token of guildSettings.tokens) {
      try {
        const address = await getAccountAddressForToken(targetUserId, token);
        if (!address) {
          console.error(`Could not resolve address for ${targetUserId} on ${token.chain}`);
          balanceLines.push(`? ${token.symbol}`);
          continue;
        }
        const balance = await getBalance(
          token.chain as SupportedChain,
          token.address,
          address,
        );
        const balanceFormatted = parseFloat(
          formatUnits(balance, token.decimals),
        ).toFixed(2);
        const tokenUrl = `https://txinfo.xyz/${token.chain}/token/${token.address}?a=${address}`;
        balanceLines.push(`**${balanceFormatted}** [${token.symbol}](<${tokenUrl}>)`);
      } catch (error) {
        console.error(`Error fetching ${token.symbol} balance:`, error);
        balanceLines.push(`? ${token.symbol}`);
      }
    }

    const header = isOwnBalance
      ? `💰 **Your balance:**`
      : `💰 **<@${targetUserId}>'s balance:**`;
    const replyContent = `${header}\n${balanceLines.join("\n")}`;

    await interaction.editReply({ content: replyContent });
  } catch (error) {
    console.error("Error fetching balance:", error);
    await interaction.editReply({
      content: `❌ Failed to fetch balance: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
