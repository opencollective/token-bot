import { burnTokensFrom, mintTokens } from "../lib/blockchain.ts";
import { replyToMessage } from "../lib/discord.ts";
import { getEnv } from "../lib/utils.ts";
import { Nostr, URI } from "../lib/nostr.ts";

const NSEC = getEnv("NOSTR_NSEC");
const nostr = Nostr.getInstance(NSEC);
const DRY_RUN = getEnv("DRY_RUN") === "true";

async function main() {
  const missingTxHashes = JSON.parse(Deno.readTextFileSync("missing-txs.json"));
  console.log("-".repeat(80));
  console.log("missingTxHashes", missingTxHashes.length);
  const args = Deno.args;
  const limit = Number(args[0]) || missingTxHashes.length;
  const skip = Number(args[1]) || 0;

  console.log("limit", limit);
  console.log("skip", skip);

  console.log("DRY_RUN", DRY_RUN);

  for (let i = skip; i < Math.min(skip + limit, missingTxHashes.length); i++) {
    missingTxHashes[i] = await processMissingTx(missingTxHashes[i]);
    Deno.writeTextFileSync(
      "missing-txs.json",
      JSON.stringify(missingTxHashes, null, 2),
    );
  }

  console.log("done");
  Deno.exit(0);
}

const channelId = Deno.env.get("DISCORD_TRANSACTIONS_CHANNEL_ID");
if (!channelId) {
  console.log("DISCORD_TRANSACTIONS_CHANNEL_ID env missing");
  Deno.exit(1);
}

const tokenAddress = Deno.env.get("TOKEN_ADDRESS");
if (!tokenAddress) {
  console.log("TOKEN_ADDRESS env missing");
  Deno.exit(1);
}

async function processMissingTx(missingTx: any) {
  if (missingTx.newTxHash) {
    console.log("Tx already processed", missingTx.newTxHash);
    return missingTx;
  }
  let replyContent, hash;
  if (missingTx.type === "mint") {
    hash = await mintTokens(
      "celo",
      tokenAddress,
      missingTx.accountAddress,
      missingTx.amount,
    );
  }
  if (missingTx.type === "burn") {
    hash = await burnTokensFrom(
      "celo",
      tokenAddress as string,
      missingTx.accountAddress,
      missingTx.amount,
    );
  }

  if (hash) {
    if (!DRY_RUN) {
      missingTx.newTxHash = hash;
    }
    replyContent = `Replaying missing transaction from ${
      missingTx.createdAt.slice(
        0,
        10,
      )
    }: ${missingTx.amount} ${missingTx.currency} to <@${missingTx.discordUserId}> ([tx](https://celoscan.io/tx/${hash}))`;
  } else {
    replyContent =
      `Failed to replay ${missingTx.type} ${missingTx.amount} ${missingTx.currency} to ${missingTx.accountAddress} ... https://celoscan.io/tx/${missingTx.txHash} from ${
        missingTx.createdAt.slice(0, 10)
      }`;
  }

  let message = `Missing tx from ${missingTx.createdAt.slice(0, 10)}`;
  if (missingTx.description) {
    message += ` for ${missingTx.description}`;
  }

  console.log("Processing", message);

  if (!DRY_RUN) {
    await replyToMessage(channelId, missingTx.messageId, replyContent);
    await nostr?.publishMetadata(`ethereum:42220:tx:${hash}` as URI, {
      content: message,
      tags: [],
    });
  }
  return missingTx;
}

main();
