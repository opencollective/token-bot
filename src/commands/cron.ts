/**
 * This script is used to burn tokens from the community
 * This script will be run as a cron job to fetch all the users of a given role
 * and burn the number of tokens that this role requires.
 * If the balance is not enough, we revoke the role.
 */
import { Discord, DiscordRoleSettings } from "../lib/discord.ts";
import {
  burnTokensFrom,
  getBalance,
  getNativeBalance,
  getWalletClient,
  hasRole,
  mintTokens,
} from "../lib/blockchain.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import rolesJSON from "../../discord-roles-rewards.json" with { type: "json" };
import communityJSON from "../../community.json" with { type: "json" };
import { formatUnits } from "@wevm/viem";
import { Nostr, URI } from "../lib/nostr.ts";

const IGNORE_USERS: string[] = [];

const ONLY_USERS: string[] = [];
const ONLY_ROLES: string[] = [];
const IGNORE_ROLES: string[] = [];

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

const roles = rolesJSON as unknown as DiscordRoleSettings[];

let txCount = 0;

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

  for (const role of roles) {
    if (IGNORE_ROLES.includes(role.id)) {
      console.log(`Ignoring role ${role.name}`);
      continue;
    }
    if (ONLY_ROLES && ONLY_ROLES.length > 0 && !ONLY_ROLES.includes(role.id)) {
      console.log(`ONLY_ROLES set: Ignoring role ${role.name}`);
      continue;
    }
    const users = await discord.getMembers(role.id);
    console.log(`>>> ${role.name}: ${users.length} users`);
    if (users.length === 0) {
      if (role.mintAmount) {
        const rolesToNotify = roles.filter((r) => r.notifications?.includes("vacancies"));
        if (rolesToNotify.length > 0) {
          const rolesMentions = rolesToNotify.map((r) => `<@&${r.id}>`).join(", ");
          await discord.postToDiscordChannel(
            `Nobody has the ${role.name} role (${role.mintAmount} ${community.primary_token.symbol} ${role.frequency}), ${rolesMentions} anyone who wants to take it?`,
          );
        }
      }
      continue;
    }
    for (const user of users) {
      if (role.frequency === "monthly") {
        if (day !== 1) {
          continue;
        }
      } else if (role.frequency === "weekly") {
        if (dayOfWeek !== 1) {
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

      if (role.burnAmount) {
        console.log(`>>> ${role.name}: burning ${role.burnAmount} tokens from ${user.displayName}`);
        try {
          hash = await burnTokensFrom(
            "celo",
            community.primary_token.address,
            userAddress,
            role.burnAmount.toString(),
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
          role.burnAmount;

        nostrMessage = `${role.frequency} cost for ${role.name} role`;

        discordMessage =
          `Burned ${role.burnAmount.toString()} CHT for <@${user.user.id}> for ${role.name} role ([tx](<${communityJSON.scan.url}/tx/${hash}>)), new balance: ${newBalance} ${community.primary_token.symbol} ([View account](<https://txinfo.xyz/celo/address/${userAddress}>))`;
      } else if (role.mintAmount) {
        console.log(`>>> ${role.name}: minting ${role.mintAmount} tokens for ${user.displayName}`);
        hash = await mintTokens(
          "celo",
          community.primary_token.address,
          userAddress,
          role.mintAmount.toString(),
        );

        txUri = `ethereum:${community.primary_token.chain_id}:tx:${hash}` as URI;

        const newBalance = Number(formatUnits(currentBalance, community.primary_token.decimals)) +
          role.mintAmount;

        nostrMessage = `${role.frequency} issuance for ${role.name} role`;
        discordMessage =
          `Minted ${role.mintAmount.toString()} CHT for <@${user.user.id}> for ${role.name} role ([tx](<${communityJSON.scan.url}/tx/${hash}>)), new balance: ${newBalance} ${community.primary_token.symbol} ([View account](<https://txinfo.xyz/celo/address/${userAddress}>))`;

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
  console.log(">>> done");
  Deno.exit(0);
};

main();
