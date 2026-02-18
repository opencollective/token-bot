#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
/**
 * Backfill CHT transaction messages to the Discord transactions channel.
 *
 * Reads on-chain Transfer events for the CHT token since a given tx,
 * resolves wallet addresses → Discord users via the CitizenWallet card manager,
 * fetches Nostr NIP-73 annotations (kind 1111) for each tx,
 * then posts them (oldest-first) to the configured Discord channel.
 *
 * Usage:
 *   deno task backfill [--dry-run] [--after <txHash>] [--yes]
 *
 * Or directly:
 *   deno run --env-file=.env --allow-net --allow-env --allow-read scripts/backfill-transactions.ts
 *
 * Env:
 *   DISCORD_BOT_TOKEN  – required
 *   DISCORD_GUILD_ID   – default 1280532848604086365
 *   CHANNEL_ID         – default 1354115945718878269 (cht-transactions)
 */

import { createPublicClient, http, parseAbiItem, keccak256, toBytes } from "@wevm/viem";
import { celo } from "@wevm/viem/chains";

// ── Config ──────────────────────────────────────────────────────────
const BOT_TOKEN   = Deno.env.get("DISCORD_BOT_TOKEN");
const GUILD_ID    = Deno.env.get("DISCORD_GUILD_ID") || "1280532848604086365";
const CHANNEL_ID  = Deno.env.get("CHANNEL_ID") || "1354115945718878269";
const AFTER_TX    = Deno.args.includes("--after")
  ? Deno.args[Deno.args.indexOf("--after") + 1]
  : "0x7212ba265a0ade1d73c3c8e1c9eed67c1c5877b7c3d4cae3eb92aba49076ecc3";
const DRY_RUN     = Deno.args.includes("--dry-run");
const SKIP_CONFIRM = Deno.args.includes("--yes");

const CHT_ADDRESS = "0x65dd32834927de9e57e72a3e2130a19f81c6371d";
const CHT_DECIMALS = 6;
const CARD_MANAGER = "0xBA861e2DABd8316cf11Ae7CdA101d110CF581f28";
const CARD_INSTANCE_ID = "cw-discord-1";
const NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const TOKEN_URL = `https://txinfo.xyz/celo/token/${CHT_ADDRESS}`;

if (!BOT_TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN is required");
  Deno.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────
const viemClient = createPublicClient({
  chain: celo,
  transport: http("https://forno.celo.org"),
});

const CARD_ABI = [{
  type: "function" as const,
  name: "getCardAddress" as const,
  inputs: [
    { name: "id", type: "bytes32" as const },
    { name: "hashedSerial", type: "bytes32" as const },
  ],
  outputs: [{ name: "", type: "address" as const }],
  stateMutability: "view" as const,
}];

async function discordGet(path: string) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function discordPost(channelId: string, content: string) {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Discord POST ${res.status}: ${await res.text()}`);
  return res.json();
}

function ask(question: string): Promise<string> {
  const buf = new Uint8Array(64);
  Deno.stdout.writeSync(new TextEncoder().encode(question));
  const n = Deno.stdin.readSync(buf);
  return Promise.resolve(new TextDecoder().decode(buf.subarray(0, n!)).trim());
}

// ── Step 1: Fetch on-chain transfers ────────────────────────────────
console.log("📡 Fetching on-chain transfers...");

const receipt = await viemClient.getTransactionReceipt({ hash: AFTER_TX as `0x${string}` });
console.log(`   Starting after block ${receipt.blockNumber}`);

const logs = await viemClient.getLogs({
  address: CHT_ADDRESS as `0x${string}`,
  event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  fromBlock: receipt.blockNumber + 1n,
  toBlock: "latest",
});

const ZERO = "0x0000000000000000000000000000000000000000";

interface Transfer {
  type: string;
  txHash: string;
  from: string;
  to: string;
  amount: number;
  address: string;
  date: Date;
}

const transfers: Transfer[] = [];

for (const log of logs) {
  const from = log.args.from!;
  const to = log.args.to!;
  const amount = Number(log.args.value!) / 10 ** CHT_DECIMALS;
  const isMint = from === ZERO;
  const isBurn = to === ZERO;
  const type = isMint ? "MINT" : isBurn ? "BURN" : "TRANSFER";
  const block = await viemClient.getBlock({ blockNumber: log.blockNumber! });

  transfers.push({
    type,
    txHash: log.transactionHash!,
    from, to, amount,
    address: isBurn ? from : to,
    date: new Date(Number(block.timestamp) * 1000),
  });
}

console.log(`   Found ${transfers.length} transfers\n`);

if (transfers.length === 0) {
  console.log("Nothing to post.");
  Deno.exit(0);
}

// ── Step 2: Resolve addresses → Discord users ───────────────────────
console.log("👥 Resolving wallet addresses to Discord users...");

// Fetch all guild members (paginated)
interface DiscordMember {
  user: { id: string; username: string; global_name?: string };
  nick?: string;
}

const allMembers: DiscordMember[] = [];
let after = "0";
while (true) {
  const batch: DiscordMember[] = await discordGet(`/guilds/${GUILD_ID}/members?limit=1000&after=${after}`);
  if (batch.length === 0) break;
  allMembers.push(...batch);
  after = batch[batch.length - 1].user.id;
  if (batch.length < 1000) break;
}
console.log(`   Fetched ${allMembers.length} guild members`);

const hashedInstanceId = keccak256(toBytes(CARD_INSTANCE_ID));
const uniqueAddresses = [...new Set(transfers.map(t => t.address.toLowerCase()))];
const addressToUser = new Map<string, { userId: string; displayName: string }>();

let resolved = 0;
for (const member of allMembers) {
  if (uniqueAddresses.length === addressToUser.size) break;
  try {
    const userId = member.user.id;
    const hashedUserId = keccak256(toBytes(userId));
    const walletAddress = await viemClient.readContract({
      address: CARD_MANAGER as `0x${string}`,
      abi: CARD_ABI,
      functionName: "getCardAddress",
      args: [hashedInstanceId, hashedUserId],
    }) as string;

    if (uniqueAddresses.includes(walletAddress.toLowerCase())) {
      const displayName = member.nick || member.user.global_name || member.user.username;
      addressToUser.set(walletAddress.toLowerCase(), { userId, displayName });
      resolved++;
      console.log(`   ✅ ${walletAddress.slice(0, 10)}… → @${displayName}`);
    }
  } catch (_e) {
    // skip
  }
}
console.log(`   Resolved ${resolved}/${uniqueAddresses.length} addresses\n`);

function formatUser(addr: string): string {
  const user = addressToUser.get(addr.toLowerCase());
  if (user) return `<@${user.userId}>`;
  return `\`${addr.slice(0, 6)}…${addr.slice(-4)}\``;
}

// ── Step 3: Fetch Nostr NIP-73 annotations ──────────────────────────
console.log("📝 Fetching Nostr annotations...");

const txUris = transfers.map(t => `ethereum:42220:tx:${t.txHash}`);
const nostrMap = new Map<string, string>();

await new Promise<void>((resolve) => {
  let closed = 0;

  for (const relay of NOSTR_RELAYS) {
    try {
      const ws = new WebSocket(relay);
      const timeout = setTimeout(() => { try { ws.close(); } catch(_e) {} }, 10000);

      ws.onopen = () => {
        ws.send(JSON.stringify(["REQ", "bf1", { "#i": txUris, limit: 200 }]));
        ws.send(JSON.stringify(["REQ", "bf2", { "#I": txUris, limit: 200 }]));
      };

      ws.onmessage = (evt: MessageEvent) => {
        const msg = JSON.parse(evt.data as string);
        if (msg[0] === "EVENT") {
          const event = msg[2];
          const iTags = event.tags.filter((t: string[]) => t[0] === "i" || t[0] === "I");
          for (const tag of iTags) {
            const match = tag[1].match(/tx:(0x[a-fA-F0-9]+)/);
            if (match && !nostrMap.has(match[1])) {
              nostrMap.set(match[1], event.content);
            }
          }
        }
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        closed++;
        if (closed >= NOSTR_RELAYS.length) resolve();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        try { ws.close(); } catch(_e) {}
      };
    } catch (_e) {
      closed++;
      if (closed >= NOSTR_RELAYS.length) resolve();
    }
  }

  setTimeout(resolve, 12000);
});

console.log(`   Found ${nostrMap.size} annotations\n`);

// ── Step 4: Build messages ──────────────────────────────────────────
const messages = transfers.map((tx) => {
  const emoji = tx.type === "MINT" ? "🪙" : tx.type === "BURN" ? "🔥" : "💸";
  const verb = tx.type === "MINT" ? "Minted" : tx.type === "BURN" ? "Burned" : "Transferred";
  const prep = tx.type === "BURN" ? "from" : tx.type === "MINT" ? "for" : "to";
  const user = formatUser(tx.address);
  const txUrl = `https://txinfo.xyz/celo/tx/${tx.txHash}`;
  const nostrDesc = nostrMap.get(tx.txHash);
  const desc = nostrDesc ? `\n📝 ${nostrDesc}` : "";

  return `${emoji} ${verb} ${tx.amount} [CHT](<${TOKEN_URL}>) ${prep} ${user} [[tx]](<${txUrl}>)${desc}`;
});

// ── Step 5: Preview ─────────────────────────────────────────────────
console.log("═".repeat(60));
console.log(`📋 ${messages.length} messages to post to #cht-transactions`);
console.log("═".repeat(60));
messages.forEach((msg, i) => {
  console.log(`\n${i + 1}. ${msg}`);
});
console.log("\n" + "═".repeat(60));

if (DRY_RUN) {
  console.log("\n🏁 Dry run complete. No messages posted.");
  Deno.exit(0);
}

// ── Step 6: Confirm & post ──────────────────────────────────────────
if (!SKIP_CONFIRM) {
  const answer = ask(`\nPost ${messages.length} messages to channel ${CHANNEL_ID}? (yes/no) `);
  if ((await answer).toLowerCase() !== "yes" && (await answer).toLowerCase() !== "y") {
    console.log("Aborted.");
    Deno.exit(0);
  }
}

console.log("\n🚀 Posting messages...");
for (let i = 0; i < messages.length; i++) {
  try {
    await discordPost(CHANNEL_ID, messages[i]);
    console.log(`   ✅ ${i + 1}/${messages.length}`);
    if (i < messages.length - 1) {
      await new Promise(r => setTimeout(r, 1200));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ ${i + 1}/${messages.length}: ${msg}`);
  }
}

console.log("\n🏁 Done!");
