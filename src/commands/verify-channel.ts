/**
 * This script is used to remove messages from a Discord channel.
 * Usage: deno run remove-messages --channel-id <channel-id> --since-message-id <message-id>
 */

import { getBlockchainTxInfo } from "../lib/blockchain.ts";
import { fetchLatestMessagesFromChannel } from "../lib/discord.ts";
import { parseMessageContent } from "../lib/utils.ts";
import { ethers } from "npm:ethers";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";

const usage = `
Usage: deno run verify-channel --since-message-id <message-id>
`;

async function main() {
  const channelId = Deno.env.get("DISCORD_CHANNEL_ID");
  const sinceMessageId = Deno.args[1];

  const provider = new ethers.JsonRpcProvider("https://forno.celo.org");

  if (!channelId) {
    console.log("Channel ID is required");
    console.log(usage);
    return;
  }

  if (!sinceMessageId) {
    console.log("Since message ID is required");
    console.log(usage);
    return;
  }

  const messages = await fetchLatestMessagesFromChannel(
    channelId,
    sinceMessageId,
    2000
  );

  const missingTxHashes: {
    createdAt: Date;
    messageId: string;
    discordUserId: string;
    accountAddress: string;
    txHash: string;
  }[] = [];
  await Promise.all(
    messages.map(async (message) => {
      const messageAction = parseMessageContent(message.content);
      if (!messageAction?.txHash) {
        // console.log("No tx hash found for message", message.content);
        return;
      }

      if (!messageAction.accountAddress) {
        messageAction.accountAddress =
          (await getAccountAddressFromDiscordUserId(
            messageAction.discordUserId
          )) || "";
      }

      const txReceipt = await getBlockchainTxInfo(
        "celo",
        messageAction.txHash,
        provider
      );
      if (!txReceipt) {
        console.log(
          `❌`,
          message.createdAt.toISOString().slice(0, 10),
          `https://celoscan.io/tx/${messageAction?.txHash}`
        );
        missingTxHashes.push({
          ...messageAction,
          createdAt: message.createdAt,
          messageId: message.id,
        });
        // if (!messageAction.accountAddress) {
        //   console.log("No account address found for message", message.content);
        //   messageAction.accountAddress =
        //     (await getAccountAddressFromDiscordUserId(
        //       messageAction.discordUserId
        //     )) || "";
        // }
      } else {
        // console.log(
        //   `✅`,
        //   message.createdAt.toISOString().slice(0, 10),
        //   `https://celoscan.io/tx/${messageAction?.txHash}`
        // );
      }
    })
  );

  // console.log(
  //   ">>> messages to check since message ID",
  //   sinceMessageId,
  //   messageIds
  // );

  try {
    // await removeMessagesFromChannel(channelId, messageIds);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }

  console.log(
    ">>>",
    messages.length,
    "messages",
    missingTxHashes.length,
    "missing txs"
  );
  console.log(missingTxHashes);
  missingTxHashes.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  Deno.writeTextFileSync(
    "missing-txs.json",
    JSON.stringify(missingTxHashes, null, 2)
  );
  Deno.exit(0);
}

main();
