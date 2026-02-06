import { Interaction, TextChannel } from "discord.js";
import { loadGuildSettings } from "../lib/utils.ts";
import { Nostr, URI } from "../lib/nostr.ts";
import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import {
  BundlerService,
  CommunityConfig,
  callOnCardCallData,
  getAccountAddress,
  getAccountBalance,
  getCardAddress,
  tokenTransferCallData,
  tokenTransferEventTopic,
  type UserOpData,
  type UserOpExtraData,
} from "@citizenwallet/sdk";
import { formatUnits, parseUnits } from "@wevm/viem";
import { SupportedChain, ChainConfig } from "../lib/blockchain.ts";

// Build a CommunityConfig from guild settings
function buildCommunityConfig(guildSettings: any): any {
  const chain = guildSettings.contributionToken.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;
  const tokenAddress = guildSettings.contributionToken.address;
  const tokenSymbol = guildSettings.contributionToken.symbol;
  const tokenDecimals = guildSettings.contributionToken.decimals;
  
  // Card manager address (same as in citizenwallet.ts)
  const cardManagerAddress = "0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28";
  
  // These are standard Citizen Wallet infrastructure addresses for Celo
  const entrypointAddress = "0x7079253c0358eF9Fd87E16488299Ef6e06F403B6";
  const paymasterAddress = "0xe5Eb4fB0F3312649Eb7b62fba66C9E26579D7208";
  const accountFactoryAddress = "0x940Cbb155161dc0C4aade27a4826a16Ed8ca0cb2";
  
  return {
    community: {
      name: guildSettings.guild?.name || "Token Bot Community",
      description: "Discord Token Bot Community",
      alias: "token-bot",
      primary_token: {
        address: tokenAddress,
        chain_id: chainId,
      },
      primary_account_factory: {
        address: accountFactoryAddress,
        chain_id: chainId,
      },
      primary_card_manager: {
        address: cardManagerAddress,
        chain_id: chainId,
      },
    },
    tokens: {
      [`${chainId}:${tokenAddress}`]: {
        standard: "erc20",
        name: tokenSymbol,
        address: tokenAddress,
        symbol: tokenSymbol,
        decimals: tokenDecimals,
        chain_id: chainId,
      },
    },
    accounts: {
      [`${chainId}:${accountFactoryAddress}`]: {
        chain_id: chainId,
        entrypoint_address: entrypointAddress,
        paymaster_address: paymasterAddress,
        account_factory_address: accountFactoryAddress,
        paymaster_type: "cw-safe",
      },
    },
    cards: {
      [`${chainId}:${cardManagerAddress}`]: {
        chain_id: chainId,
        instance_id: "cw-discord-1",
        address: cardManagerAddress,
        type: "safe",
      },
    },
    chains: {
      [chainId.toString()]: {
        id: chainId,
        node: {
          url: `https://${chainId}.engine.citizenwallet.xyz`,
          ws_url: `wss://${chainId}.engine.citizenwallet.xyz`,
        },
      },
    },
  };
}

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
    // Build community config
    const communityConfigData = buildCommunityConfig(guildSettings);
    const community = new CommunityConfig(communityConfigData);
    
    // Get sender's card address
    const senderHashedUserId = keccak256(toUtf8Bytes(userId));
    const senderAddress = await getCardAddress(community, senderHashedUserId);
    
    if (!senderAddress) {
      await interaction.editReply({
        content: "❌ Could not find your account. Please make sure you're registered.",
      });
      return;
    }

    // Get recipient's card address
    const recipientHashedUserId = keccak256(toUtf8Bytes(recipientUserId));
    const recipientAddress = await getCardAddress(community, recipientHashedUserId);
    
    if (!recipientAddress) {
      await interaction.editReply({
        content: "❌ Could not find recipient's account. They may need to register first.",
      });
      return;
    }

    // Check sender's balance
    const balance = await getAccountBalance(community, senderAddress) ?? BigInt(0);
    const formattedAmount = parseUnits(amount.toFixed(decimals), decimals);
    
    if (balance < formattedAmount) {
      const balanceFormatted = formatUnits(balance, decimals);
      await interaction.editReply({
        content: `❌ Insufficient balance. You have ${balanceFormatted} ${tokenSymbol} but tried to send ${amount} ${tokenSymbol}.`,
      });
      return;
    }

    // Get bot's private key for signing
    const privateKey = Deno.env.get("PRIVATE_KEY");
    if (!privateKey) {
      await interaction.editReply({
        content: "❌ Bot configuration error: Private key not set.",
      });
      return;
    }

    const signer = new Wallet(privateKey);
    
    // Get signer's account address
    const signerAccountAddress = await getAccountAddress(community, signer.address);
    if (!signerAccountAddress) {
      await interaction.editReply({
        content: "❌ Could not find bot's account address.",
      });
      return;
    }

    // Create bundler service
    const bundler = new BundlerService(community);
    
    // Create transfer calldata
    const transferCalldata = tokenTransferCallData(recipientAddress, formattedAmount);
    
    // Wrap in card call
    const calldata = callOnCardCallData(
      community,
      senderHashedUserId,
      guildSettings.contributionToken.address,
      BigInt(0),
      transferCalldata
    );
    
    const cardConfig = community.primarySafeCardConfig;
    
    // User operation data
    const userOpData: UserOpData = {
      topic: tokenTransferEventTopic,
      from: senderAddress,
      to: recipientAddress,
      value: formattedAmount.toString(),
    };
    
    let extraData: UserOpExtraData | undefined;
    if (message) {
      extraData = {
        description: message,
      };
    }

    // Execute the transfer
    const hash = await bundler.call(
      signer,
      cardConfig.address,
      signerAccountAddress,
      calldata,
      BigInt(0),
      userOpData,
      extraData
    );

    const txUri = `ethereum:${chainId}:tx:${hash}` as URI;

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
