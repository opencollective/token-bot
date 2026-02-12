import { Interaction } from "discord.js";
import { getBalance, SupportedChain } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import { formatUnits } from "@wevm/viem";
import type { Chain } from "../types.ts";

interface TokenInfo {
  name: string;
  symbol: string;
  address: string;
  chain: Chain;
  decimals: number;
}

// Get all tokens from settings
function getAllTokens(settings: any): TokenInfo[] {
  const tokens: TokenInfo[] = [];

  // Contribution token (legacy)
  if (settings.contributionToken?.address) {
    tokens.push({
      name: settings.contributionToken.name,
      symbol: settings.contributionToken.symbol,
      address: settings.contributionToken.address,
      chain: settings.contributionToken.chain,
      decimals: settings.contributionToken.decimals,
    });
  }

  // Fiat token (if exists)
  if (settings.fiatToken?.address) {
    tokens.push({
      name: settings.fiatToken.name,
      symbol: settings.fiatToken.symbol,
      address: settings.fiatToken.address,
      chain: settings.fiatToken.chain,
      decimals: settings.fiatToken.decimals,
    });
  }

  // Additional tokens from tokens array
  const additionalTokens = settings.tokens || [];
  for (const token of additionalTokens) {
    if (token?.address) {
      tokens.push({
        name: token.name,
        symbol: token.symbol,
        address: token.address,
        chain: token.chain,
        decimals: token.decimals,
      });
    }
  }

  return tokens;
}

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
  if (!guildSettings) {
    await interaction.reply({
      content: "❌ Guild settings not found.",
      ephemeral: true,
    });
    return;
  }

  const tokens = getAllTokens(guildSettings);
  if (tokens.length === 0) {
    await interaction.reply({
      content: "❌ No tokens configured. Run `/add-token` first.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

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

    // Fetch balances for all tokens
    const balances: string[] = [];
    for (const token of tokens) {
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
    const primaryChain = tokens[0].chain;
    const txInfoUrl = `https://txinfo.xyz/${primaryChain}/address/${address}`;

    const balanceList = balances.join(" · ");
    let replyContent: string;
    if (isOwnBalance) {
      replyContent = `💰 Your balance: ${balanceList}\n[[view account]](<${txInfoUrl}>)`;
    } else {
      replyContent = `💰 <@${targetUserId}>'s balance: ${balanceList}\n[[view account]](<${txInfoUrl}>)`;
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
