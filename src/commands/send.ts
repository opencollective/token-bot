import { Interaction, TextChannel } from "discord.js";
import { burnTokensFrom, mintTokens, getBalance, SupportedChain, ChainConfig } from "../lib/blockchain.ts";
import { loadGuildSettings } from "../lib/utils.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import { formatUnits } from "@wevm/viem";

export default async function handleSendCommand(
  interaction: Interaction,
  userId: string,
  guildId: string,
) {
  console.log("handleSendCommand");
  if (!interaction.isChatInputCommand() || !interaction.options) {
    console.error("Interaction is not a chat input command or has no options");
    return;
  }

  const recipientUser = interaction.options.getUser("user");
  const amount = interaction.options.getNumber("amount");
  const message = interaction.options.getString("message") || undefined;

  if (!recipientUser || !amount) {
    await interaction.reply({
      content: "❌ Missing required options.",
      ephemeral: true,
    });
    return;
  }

  const recipientUserId = recipientUser.id;

  // Can't send to yourself
  if (recipientUserId === userId) {
    await interaction.reply({
      content: "❌ You cannot send tokens to yourself.",
      ephemeral: true,
    });
    return;
  }

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
  const chainId = ChainConfig[chain].id;
  const tokenSymbol = guildSettings.contributionToken.symbol;
  const decimals = guildSettings.contributionToken.decimals;

  try {
    // Convert Discord user IDs to blockchain addresses
    const senderAddress = await getAccountAddressFromDiscordUserId(userId);
    const recipientAddress = await getAccountAddressFromDiscordUserId(recipientUserId);

    if (!senderAddress || !recipientAddress) {
      await interaction.editReply({
        content: "❌ Could not resolve blockchain addresses for users.",
      });
      return;
    }

    // Check sender's balance
    const balance = await getBalance(chain, guildSettings.contributionToken.address, senderAddress);
    const balanceFormatted = parseFloat(formatUnits(balance, decimals)).toFixed(2);
    
    if (parseFloat(balanceFormatted) < amount) {
      await interaction.editReply({
        content: `❌ Insufficient balance. You have ${balanceFormatted} ${tokenSymbol} but tried to send ${amount} ${tokenSymbol}.`,
      });
      return;
    }

    // Burn from sender
    const burnHash = await burnTokensFrom(
      chain,
      guildSettings.contributionToken.address,
      senderAddress,
      amount.toString(),
      decimals,
    );

    if (!burnHash) {
      await interaction.editReply({
        content: "❌ Failed to send tokens (burn step failed).",
      });
      return;
    }

    // Mint to recipient
    const mintHash = await mintTokens(
      chain,
      guildSettings.contributionToken.address,
      recipientAddress,
      amount.toString(),
      decimals,
    );

    if (!mintHash) {
      await interaction.editReply({
        content: "❌ Failed to send tokens (mint step failed). Please contact an admin - tokens were burned but not credited.",
      });
      return;
    }

    const txUri = `ethereum:${chainId}:tx:${mintHash}` as URI;

    // Post to Discord transactions channel
    if (guildSettings.channels?.transactions && interaction.guild) {
      try {
        const transactionsChannel = await interaction.guild.channels.fetch(
          guildSettings.channels.transactions,
        ) as TextChannel;

        if (transactionsChannel) {
          let discordMessage = `💸 <@${userId}> sent ${amount} ${tokenSymbol} to <@${recipientUserId}>`;
          if (message) {
            discordMessage += `: ${message}`;
          }
          await transactionsChannel.send(discordMessage);
        }
      } catch (error) {
        console.error("Error sending message to transactions channel:", error);
      }
    }

    // Publish metadata to Nostr
    try {
      const nostr = Nostr.getInstance();
      const nostrContent = message || `Sent ${amount} ${tokenSymbol} to Discord user`;

      await nostr.publishMetadata(txUri, {
        content: nostrContent,
        tags: [
          ["t", "send"],
          ["t", "transfer"],
          ["amount", amount.toString()],
        ],
      });
    } catch (error) {
      console.error("Error sending Nostr annotation:", error);
    }

    let replyContent = `✅ Sent ${amount} ${tokenSymbol} to <@${recipientUserId}>`;
    if (message) {
      replyContent += `\n📝 ${message}`;
    }

    await interaction.editReply({
      content: replyContent,
    });
  } catch (error) {
    console.error("Error sending tokens:", error);
    await interaction.editReply({
      content: `❌ Failed to send tokens: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
