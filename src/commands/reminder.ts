/**
 * This script is used to remind the users about the roles they have
 * and make sure they are still active.
 */
import { Discord, DiscordRoleSettings } from "../lib/discord.ts";
import { getBalance } from "../lib/blockchain.ts";
import { getAccountAddressFromDiscordUserId } from "../lib/citizenwallet.ts";
import rolesJSON from "../../discord-roles-rewards.json" with { type: "json" };
import communityJSON from "../../community.json" with { type: "json" };
import { formatUnits } from "@wevm/viem";

const IGNORE_USERS: string[] = [];

const ONLY_USERS: string[] = [];
const ONLY_ROLES: string[] = [];
const IGNORE_ROLES: string[] = ["1414581689581310052"];

const DRY_RUN = Deno.env.get("DRY_RUN") === "true";

const community = communityJSON.community;
const discord = Discord.getInstance();
if (!discord) {
  console.error("Discord instance not found");
  Deno.exit(1);
}

console.log(`DRY_RUN: ${DRY_RUN}`);

const roles = rolesJSON as unknown as DiscordRoleSettings[];

const main = async () => {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const activeUsers = await discord.getActiveUsers(
    Deno.env.get("DISCORD_CONTRIBUTIONS_CHANNEL_ID") as string,
    since,
  );
  console.log(
    `>>> ${activeUsers.length} active members`,
    activeUsers.map((member) => member.globalName),
  );

  const activeUserIds = activeUsers.map((member) => member.id);

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
      continue;
    }
    for (const user of users) {
      if (ONLY_USERS && ONLY_USERS.length > 0 && !ONLY_USERS.includes(user.displayName)) {
        console.log(`ONLY_USERS set: Ignoring user ${user.displayName}`);
        continue;
      }

      if (IGNORE_USERS && IGNORE_USERS.length > 0 && IGNORE_USERS.includes(user.displayName)) {
        console.log(`IGNORE_USERS set: Ignoring user ${user.displayName}`);
        continue;
      }

      if (activeUserIds.includes(user.id)) {
        console.log(`User ${user.displayName} is active, skipping`);
        continue;
      }

      if (role.mintAmount) {
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
        const formattedBalance = Number(
          formatUnits(currentBalance, community.primary_token.decimals),
        );

        console.log(
          `>>> ${role.name}: reminding ${user.displayName} about their ${role.name} role`,
        );
        const discordMessage =
          `<@${user.user.id}> don't forget to post an update for your ${role.name} role to receive the weekly allowance (${role.mintAmount} ${community.primary_token.symbol}). Your currently have ${formattedBalance} ${community.primary_token.symbol} ([View account](<https://txinfo.xyz/celo/address/${userAddress}>))`;

        await discord.postToDiscordChannel(
          discordMessage as string,
          Deno.env.get("DISCORD_CONTRIBUTIONS_CHANNEL_ID") as string,
        );
      }
    }
  }
  console.log(">>> done");
  Deno.exit(0);
};

main();
