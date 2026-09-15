// Shared token transfer used by /send and the :coin: emoji reaction handler.
import { Client, TextChannel } from "discord.js";
import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import {
  BundlerService,
  callOnCardCallData,
  CommunityConfig,
  getAccountAddress,
  getCardAddress,
  tokenTransferCallData,
  tokenTransferEventTopic,
  type UserOpData,
  type UserOpExtraData,
} from "@citizenwallet/sdk";
import { parseUnits } from "@wevm/viem";
import { ChainConfig, getBalance, parseInsufficientGasError, SupportedChain } from "./blockchain.ts";
import { getAccountAddressForToken } from "./citizenwallet.ts";
import { Nostr, URI } from "./nostr.ts";
import { refreshTokenStats } from "./token-stats-cache.ts";
import {
  formatAmount,
  type MintSource as TxSource,
  type Recipient,
  tokenLinkFor,
  tokenTag,
  txUrlFor,
} from "./mint.ts";
import type { GuildSettings, Token } from "../types.ts";

export type { TxSource };

export type SendResult = {
  recipient: Recipient;
  success: boolean;
  hash?: string;
  error?: string;
};

export type ExecuteSendOptions = {
  client: Client;
  guildSettings: GuildSettings;
  token: Token;
  senderId: string; // Discord user id
  senderAddress?: string; // Resolved if omitted
  recipients: Recipient[];
  amount: number; // Per recipient
  description?: string;
  source?: TxSource;
};

// deno-lint-ignore no-explicit-any
export function buildCommunityConfig(guildSettings: GuildSettings, token: Token): any {
  const chain = token.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;
  return {
    community: {
      name: guildSettings.guild?.name || "Token Bot Community",
      description: "Discord Token Bot Community",
      alias: "token-bot",
      primary_token: { address: token.address, chain_id: chainId },
      primary_account_factory: { address: "0x940Cbb155161dc0C4aade27a4826a16Ed8ca0cb2", chain_id: chainId },
      primary_card_manager: { address: "0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28", chain_id: chainId },
    },
    tokens: {
      [`${chainId}:${token.address}`]: {
        standard: "erc20",
        name: token.symbol,
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        chain_id: chainId,
      },
    },
    accounts: {
      [`${chainId}:0x940Cbb155161dc0C4aade27a4826a16Ed8ca0cb2`]: {
        chain_id: chainId,
        entrypoint_address: "0x7079253c0358eF9Fd87E16488299Ef6e06F403B6",
        paymaster_address: "0xe5Eb4fB0F3312649Eb7b62fba66C9E26579D7208",
        account_factory_address: "0x940Cbb155161dc0C4aade27a4826a16Ed8ca0cb2",
        paymaster_type: "cw-safe",
      },
    },
    cards: {
      [`${chainId}:0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28`]: {
        chain_id: chainId,
        instance_id: "cw-discord-1",
        address: "0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28",
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

// Sender balance in token units (bigint), or null when the address can't be resolved.
export async function getSenderBalance(
  senderId: string,
  token: Token,
): Promise<{ address: string; balance: bigint } | null> {
  const address = await getAccountAddressForToken(senderId, token);
  if (!address) return null;
  const balance = await getBalance(token.chain as SupportedChain, token.address, address);
  return { address, balance };
}

export function toUnits(amount: number, token: Token): bigint {
  return parseUnits(amount.toFixed(token.decimals), token.decimals);
}

// Transfer `amount` to one recipient. Throws on failure.
async function transferOnce(
  opts: ExecuteSendOptions & { senderAddress: string; recipient: Recipient },
): Promise<string> {
  const { guildSettings, token, senderId, senderAddress, recipient, amount, description } = opts;
  const walletManager = token.walletManager || "opencollective";
  const amountWei = toUnits(amount, token);

  if (walletManager === "opencollective") {
    const { Token: OCToken } = await import("@opencollective/token-factory");
    const ocToken = new OCToken({
      name: token.name,
      symbol: token.symbol,
      chain: token.chain,
      tokenAddress: token.address,
    });
    return await ocToken.transfer(`discord:${senderId}`, recipient.accountId, amountWei);
  }

  // Citizen Wallet bundler-based transfer
  if (recipient.type !== "discord") {
    throw new Error("CitizenWallet does not support email recipients");
  }
  const community = new CommunityConfig(buildCommunityConfig(guildSettings, token));
  const senderHashedUserId = keccak256(toUtf8Bytes(senderId));
  const recipientHashedUserId = keccak256(toUtf8Bytes(recipient.id));
  const recipientAddress = await getCardAddress(community, recipientHashedUserId);
  if (!recipientAddress) throw new Error("Could not find recipient's account.");

  const privateKey = Deno.env.get("PRIVATE_KEY");
  if (!privateKey) throw new Error("Bot configuration error: Private key not set.");

  const signer = new Wallet(privateKey);
  const signerAccountAddress = await getAccountAddress(community, signer.address);
  if (!signerAccountAddress) throw new Error("Could not find bot's account address.");

  const bundler = new BundlerService(community);
  const transferCalldata = tokenTransferCallData(recipientAddress, amountWei);
  const calldata = callOnCardCallData(
    community,
    senderHashedUserId,
    token.address,
    BigInt(0),
    transferCalldata,
  );
  const userOpData: UserOpData = {
    topic: tokenTransferEventTopic,
    from: senderAddress,
    to: recipientAddress,
    value: amountWei.toString(),
  };
  const extraData: UserOpExtraData | undefined = description ? { description } : undefined;

  return await bundler.call(
    // deno-lint-ignore no-explicit-any
    signer as any,
    community.primarySafeCardConfig.address,
    signerAccountAddress,
    calldata,
    BigInt(0),
    userOpData,
    extraData,
  );
}

// Send `amount` to each recipient, annotate on Nostr and post to the transactions channel.
// Returns one result per recipient; a failing recipient doesn't stop the others.
export async function executeSend(opts: ExecuteSendOptions): Promise<SendResult[]> {
  const { client, guildSettings, token, senderId, recipients, amount, description, source } = opts;
  const chain = token.chain as SupportedChain;
  const chainId = ChainConfig[chain].id;
  const results: SendResult[] = [];

  let senderAddress = opts.senderAddress;
  if (!senderAddress) {
    senderAddress = (await getAccountAddressForToken(senderId, token)) ?? undefined;
  }
  if (!senderAddress) {
    return recipients.map((recipient) => ({
      recipient,
      success: false,
      error: "Could not resolve your wallet address",
    }));
  }

  for (const recipient of recipients) {
    try {
      const hash = await transferOnce({ ...opts, senderAddress, recipient });
      results.push({ recipient, success: true, hash });

      try {
        const nostr = Nostr.getInstance();
        const tags: string[][] = [
          ["t", "send"],
          ["t", "transfer"],
          ["amount", amount.toString()],
          ["token", tokenTag(token)],
        ];
        if (source) {
          tags.push(["via", source.via]);
          if (source.messageUrl) tags.push(["r", source.messageUrl]);
        }
        await nostr.publishMetadata(`ethereum:${chainId}:tx:${hash}` as URI, {
          content: description || `Sent ${amount} ${token.symbol} to ${recipient.label}`,
          tags,
        });
      } catch (err) {
        console.error("Error publishing Nostr:", err);
      }
    } catch (error) {
      console.error(`Error sending to ${recipient.label}:`, error);
      const gasErr = await parseInsufficientGasError(error, chain);
      const message = gasErr
        ? gasErr.formatMessage("send")
        : error instanceof Error
        ? error.message
        : String(error);
      results.push({ recipient, success: false, error: message });
    }
  }

  const successful = results.filter((r) => r.success);
  const txChannelId = token.transactionsChannelId || guildSettings.channels?.transactions;
  if (successful.length > 0 && txChannelId) {
    try {
      const channel = (await client.channels.fetch(txChannelId)) as TextChannel;
      if (channel) {
        const lines = successful.map((r) =>
          `💸 <@${senderId}> sent ${formatAmount(amount)} ${tokenLinkFor(token)} to ${r.recipient.label} [[tx]](<${txUrlFor(token, r.hash!)}>)`
        );
        let msg = lines.join("\n");
        if (description) msg += `\n📝 ${description}`;
        if (source?.messageUrl) msg += `\n🔗 [context](<${source.messageUrl}>)`;
        await channel.send(msg);
      }
    } catch (err) {
      console.error("Error posting to transactions channel:", err);
    }
  }

  if (successful.length > 0) {
    refreshTokenStats(token.chain, token.address, token.decimals).catch(() => {});
  }

  return results;
}
