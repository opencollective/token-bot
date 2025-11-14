/**
 * This script is used to burn tokens from the community
 * This script will be run as a cron job to fetch all the users of a given role
 * and burn the number of tokens that this role requires.
 * If the balance is not enough, we revoke the role.
 */
import { Discord } from "../lib/discord.ts";
import {
  burnTokensFrom,
  getBalance,
  getNativeBalance,
  getWalletClient,
  hasRole,
  mintTokens,
} from "../lib/blockchain.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import communityJSON from "../../community.json" with { type: "json" };
import { formatUnits } from "@wevm/viem";
import { Nostr, URI } from "../lib/nostr.ts";
import { RoleSetting } from "../types.ts";
import { loadGuildFile, loadGuildSettings, loadRoles } from "../lib/utils.ts";
import { getYesterdayTransfersSummary, Monitor } from "../lib/etherscan.ts";

const IGNORE_USERS: string[] = [];

const ONLY_USERS: string[] = [];
const ONLY_ROLES: string[] = [];
const IGNORE_ROLES: string[] = [
  "1414581689581310052",
]; // tech steward role

const LIMIT = Number(Deno.env.get("LIMIT")) || null;
const DRY_RUN = Deno.env.get("DRY_RUN") === "true";

const community = communityJSON.community;
const discord = Discord.getInstance();
if (!discord) {
  console.error("Discord instance not found");
  Deno.exit(1);
}
const nostr = Nostr.getInstance();
if (!nostr) {
  console.error("Nostr instance not found");
  Deno.exit(1);
}

console.log(`LIMIT: ${LIMIT}`);
console.log(`DRY_RUN: ${DRY_RUN}`);

let txCount = 0;

const processCommunity = async (guildId: string) => {
  const roles: RoleSetting[] = await loadRoles(guildId);
  const guildSettings = await loadGuildSettings(guildId);
  if (!guildSettings) {
    console.error(`Guild settings not found for guild ${guildId}`);
    Deno.exit(1);
  }
  const monitors = await loadGuildFile<Monitor[]>(guildId, "monitors.json");

  const contributionsChannelId = guildSettings.channels.contributions;

  console.log(
    ">>> processing community",
    guildId,
    "with",
    roles.length,
    "roles and",
    monitors?.length,
    "monitors configured",
  );

  for (const monitor of monitors) {
    const message = await getYesterdayTransfersSummary(monitor);
    if (message) {
      await discord?.postToDiscordChannel(message as string, monitor.channelId);
    }
  }

  const date = new Date();
  const day = date.getDate();
  const dayOfWeek = date.getDay();

  const since = new Date();
  since.setDate(since.getDate() - 10);
  const activeUsers = await discord.getActiveUsers(
    contributionsChannelId,
    since,
  );
  console.log(
    `>>> ${activeUsers.length} active members`,
    activeUsers.map((member) => member.globalName || member.displayName),
  );

  let sendReminder = false;
  const activeUserIds = activeUsers.map((member) => member.id);

  const vacancies: RoleSetting[] = [];

  for (const role of roles) {
    if (IGNORE_ROLES.includes(role.id)) {
      console.log(`Ignoring role ${role.name}`);
      continue;
    }
    if (ONLY_ROLES && ONLY_ROLES.length > 0 && !ONLY_ROLES.includes(role.id)) {
      console.log(`ONLY_ROLES set: Ignoring role ${role.name}`);
      continue;
    }
    if (role.frequency === "monthly") {
      if (day !== 1) {
        continue;
      }
    } else if (role.frequency === "weekly") {
      if (dayOfWeek === 5) {
        sendReminder = true;
      } else if (dayOfWeek !== 1) {
        continue;
      }
    }

    const users = await discord.getMembers(role.id);
    console.log(`>>> ${role.name}: ${users.length} users`);
    if (users.length === 0) {
      if (role.amountToMint) {
        vacancies.push(role);
      }
      continue;
    }
    for (const user of users) {
      if (role.frequency === "monthly") {
        if (day !== 1) {
          continue;
        }
      } else if (role.frequency === "weekly") {
        if (dayOfWeek !== 1 && !sendReminder) {
          continue;
        }
      }

      if (ONLY_USERS && ONLY_USERS.length > 0 && !ONLY_USERS.includes(user.displayName)) {
        console.log(`ONLY_USERS set: Ignoring user ${user.displayName}`);
        continue;
      }

      if (IGNORE_USERS && IGNORE_USERS.length > 0 && IGNORE_USERS.includes(user.displayName)) {
        console.log(`IGNORE_USERS set: Ignoring user ${user.displayName}`);
        continue;
      }

      if (LIMIT && txCount >= LIMIT) {
        continue;
      }
      const userAddress = await getAccountAddressFromDiscordUserId(user.id);
      if (!userAddress) {
        console.error(`User address not found for user ${user.id}`);
        continue;
      }
      const currentBalance = await getBalance(
        "celo",
        community.primary_token.address,
        userAddress,
      );

      let hash: string | null = null;
      let txUri: URI | null = null;
      let nostrMessage: string | null = null;
      let discordMessage: string | null = null;

      if (role.amountToBurn) {
        console.log(
          `>>> ${role.name}: burning ${role.amountToBurn} tokens from ${user.displayName}`,
        );
        try {
          hash = await burnTokensFrom(
            "celo",
            community.primary_token.address,
            userAddress,
            role.amountToBurn.toString(),
          );
        } catch (error) {
          if (error instanceof Error && error.message.includes("Insufficient balance")) {
            console.log(`>>> ${role.name}: insufficient balance for ${user.displayName}`);
            await discord.postToDiscordChannel(
              `Insufficient balance for <@${user.user.id}> for ${role.name} role, removing role`,
            );
            await discord.removeRole(user.user.id, role.id);
          } else {
            console.error(`>>> ${role.name}: error burning tokens from ${user.displayName}`, error);
          }
          continue;
        }

        txUri = `ethereum:${community.primary_token.chain_id}:tx:${hash}` as URI;

        const newBalance = Number(formatUnits(currentBalance, community.primary_token.decimals)) -
          role.amountToBurn;

        nostrMessage = `${role.frequency} cost for ${role.name} role`;

        discordMessage =
          `Burned ${role.amountToBurn.toString()} CHT for <@${user.user.id}> for ${role.name} role ([tx](<${communityJSON.scan.url}/tx/${hash}>)), new balance: ${newBalance} ${community.primary_token.symbol} ([View account](<https://txinfo.xyz/celo/address/${userAddress}>))`;
      } else if (role.amountToMint) {
        if (!activeUserIds.includes(user.id)) {
          if (sendReminder) {
            const formattedBalance = Number(
              formatUnits(currentBalance, community.primary_token.decimals),
            );

            console.log(
              `>>> ${role.name}: reminding ${user.displayName} about their ${role.name} role`,
            );
            const discordMessage =
              `<@${user.user.id}> don't forget to post an update for your ${role.name} role to receive the weekly allowance (${role.amountToMint} ${community.primary_token.symbol}). Your currently have ${formattedBalance} ${community.primary_token.symbol} ([View account](<https://txinfo.xyz/celo/address/${userAddress}>))`;

            await discord.postToDiscordChannel(
              discordMessage as string,
              contributionsChannelId,
            );
          } else {
            console.log(
              `>>> ${role.name}: user ${user.displayName} hasn't posted a contribution, skipping`,
            );
            const message =
              `${role.frequency} issuance of ${role.amountToMint} ${community.primary_token.symbol} for ${role.name} role: <@${user.user.id}> hasn't posted an update in the <#${contributionsChannelId}> channel, skipping`;
            await discord.postToDiscordChannel(message);
            continue;
          }
        }

        // Don't issue tokens if we're sending a reminder
        if (sendReminder) {
          continue;
        }

        console.log(
          `>>> ${role.name}: minting ${role.amountToMint} tokens for ${user.displayName}`,
        );
        hash = await mintTokens(
          "celo",
          community.primary_token.address,
          userAddress,
          role.amountToMint.toString(),
        );

        txUri = `ethereum:${community.primary_token.chain_id}:tx:${hash}` as URI;

        const newBalance = Number(formatUnits(currentBalance, community.primary_token.decimals)) +
          role.amountToMint;

        nostrMessage = `${role.frequency} issuance for ${role.name} role`;
        discordMessage =
          `Minted ${role.amountToMint.toString()} CHT for <@${user.user.id}> for ${role.name} role ([tx](<${communityJSON.scan.url}/tx/${hash}>)), new balance: ${newBalance} ${community.primary_token.symbol} ([View account](<https://txinfo.xyz/celo/address/${userAddress}>))`;

        txCount++;
      }

      await discord.postToDiscordChannel(discordMessage as string);
      await nostr?.publishMetadata(
        txUri as URI,
        {
          content: nostrMessage as string,
          tags: [["role", role.name]],
        },
      );
    }
  }

  if (vacancies.length > 0) {
    const roleIdsToPing: string[] = [];
    roles.forEach((r) => {
      if (r.rolesToPingIfEmpty) {
        roleIdsToPing.push(...r.rolesToPingIfEmpty);
      }
    });

    const uniqueRoleIdsToPing = [...new Set(roleIdsToPing)];

    if (uniqueRoleIdsToPing.length > 0 && ONLY_USERS.length === 0) {
      const rolesMentions = uniqueRoleIdsToPing.map((r) => `<@&${r}>`).join(", ");
      await discord.postToDiscordChannel(
        `There are ${vacancies.length} vacancies for the following roles:\n${
          vacancies.map((r) =>
            `- ${r.name} (${r.amountToMint} ${community.primary_token.symbol} ${r.frequency})`
          ).join("\n")
        }\nAnyone up to take on one of those roles? ${rolesMentions}`,
      );
    }
  }
};

const main = async () => {
  const date = new Date();
  const day = date.getDate();
  const dayOfWeek = date.getDay();

  console.log(`Running on ${day} of the month and ${dayOfWeek} of the week`);

  const botWallet = getWalletClient("celo");
  const nativeBalance = await getNativeBalance("celo", botWallet.account?.address as string);
  console.log(">>> nativeBalance", formatUnits(nativeBalance, 18));
  console.log(
    ">>> has minter role",
    await hasRole(
      "celo",
      community.primary_token.address,
      "minter",
      botWallet.account?.address as string,
    ),
  );

  await processCommunity("1280532848604086365");

  console.log(">>> done");
  Deno.exit(0);
};

main();
