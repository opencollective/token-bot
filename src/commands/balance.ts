import { Interaction } from "discord.js";
import { getBalance, SupportedChain, ChainConfig } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import { formatUnits } from "@wevm/viem";

export default async function handleBalanceCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  console.log("handleBalanceCommand");
  if (!interaction.isChatInputCommand() || !interaction.options) {
    console.error("Interaction is not a chat input command or has no options");
    return;
  }

  const targetUser = interaction.options.getUser("user");
  const targetUserId = targetUser?.id || userId;
  const isOwnBalance = targetUserId === userId;

  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    console.error("Guild settings not found");
    await interaction.reply({
      content: "❌ Guild settings not found.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const chain = guildSettings.contributionToken.chain as SupportedChain;
  const tokenSymbol = guildSettings.contributionToken.symbol;
  const decimals = guildSettings.contributionToken.decimals;

  try {
    // Get blockchain address from Discord user ID
    const address = await getAccountAddressFromDiscordUserId(targetUserId);
    
    if (!address) {
      await interaction.editReply({
        content: isOwnBalance 
          ? "❌ Could not find your account. Please make sure you're registered."
          : `❌ Could not find account for <@${targetUserId}>.`,
      });
      return;
    }

    // Get balance
    const balance = await getBalance(
      chain,
      guildSettings.contributionToken.address,
      address,
    );
    
    const balanceFormatted = parseFloat(formatUnits(balance, decimals)).toFixed(2);
    
    // Build txinfo.xyz link
    const chainName = chain === "celo" ? "celo" : chain;
    const txInfoUrl = `https://txinfo.xyz/${chainName}/address/${address}`;
    
    let replyContent: string;
    if (isOwnBalance) {
      replyContent = `💰 Your balance: **${balanceFormatted} ${tokenSymbol}**\n[[view account]](<${txInfoUrl}>)`;
    } else {
      replyContent = `💰 <@${targetUserId}>'s balance: **${balanceFormatted} ${tokenSymbol}**\n[[view account]](<${txInfoUrl}>)`;
    }

    await interaction.editReply({
      content: replyContent,
    });
  } catch (error) {
    console.error("Error fetching balance:", error);
    await interaction.editReply({
      content: `❌ Failed to fetch balance: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
