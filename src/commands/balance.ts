import { Interaction } from "discord.js";
import { getBalance, SupportedChain } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
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
    const address = await getAccountAddressFromDiscordUserId(targetUserId);

    if (!address) {
      await interaction.editReply({
        content: isOwnBalance
          ? "❌ Could not find your account. Please make sure you're registered."
          : `❌ Could not find account for <@${targetUserId}>.`,
      });
      return;
    }

    // Fetch balances for all tokens
    const balances: string[] = [];
    for (const token of guildSettings.tokens) {
      try {
        const balance = await getBalance(
          token.chain as SupportedChain,
          token.address,
          address,
        );
        const balanceFormatted = parseFloat(
          formatUnits(balance, token.decimals),
        ).toFixed(2);
        balances.push(`**${balanceFormatted} ${token.symbol}**`);
      } catch (error) {
        console.error(`Error fetching ${token.symbol} balance:`, error);
        balances.push(`? ${token.symbol}`);
      }
    }

    // Use first token's chain for txinfo link
    const primaryChain = guildSettings.tokens[0].chain;
    const txInfoUrl = `https://txinfo.xyz/${primaryChain}/address/${address}`;

    const balanceList = balances.join(" · ");
    const replyContent = isOwnBalance
      ? `💰 Your balance: ${balanceList}\n[[view account]](<${txInfoUrl}>)`
      : `💰 <@${targetUserId}>'s balance: ${balanceList}\n[[view account]](<${txInfoUrl}>)`;

    await interaction.editReply({ content: replyContent });
  } catch (error) {
    console.error("Error fetching balance:", error);
    await interaction.editReply({
      content: `❌ Failed to fetch balance: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
