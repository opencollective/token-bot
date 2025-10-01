import rolesJSON from "../discord-roles-rewards.json" with { type: "json" };

import { DiscordRoleSettings } from "../src/lib/discord.ts";
import { burnTokensFrom, deployContract, getBalance, mintTokens } from "../src/lib/blockchain.ts";
import { privateKeyToAccount } from "@wevm/viem/accounts";
import { keccak256, parseUnits, stringToHex } from "@wevm/viem";
import { expect } from "@std/expect/expect";
import communityJSON from "../community.json" with { type: "json" };
import { beforeAll } from "@std/testing/bdd";

const community = communityJSON.community;
const roles = rolesJSON as DiscordRoleSettings[];

const getAccountAddressFromDiscordUserId = (discordUserId: string) => {
  // generate a private key based on the discord user id
  const privateKey = keccak256(stringToHex(discordUserId));
  const account = privateKeyToAccount(privateKey);
  return account.address;
};

let contractAddress: string;

beforeAll(async () => {
  try {
    contractAddress = await deployContract(
      "localhost",
      "TestToken",
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      ["Test Token", "TT"],
    );
  } catch {
    console.error("Error deploying contract");
    throw new Error(
      "Error deploying contract. Make sure hardhat node is running on localhost:8545.",
    );
  }
});

const users = [
  {
    id: "1234567890",
    displayName: "John Doe",
    address: "0x1234567890123456789012345678901234567890",
  },
  {
    id: "1234567891",
    displayName: "John Appleseed",
    address: "0x1234567891123456789112345678911234567891",
  },
  {
    id: "1234567892",
    displayName: "John Smith",
    address: "0x1234567892123456789212345678921234567892",
  },
  {
    id: "1234567893",
    displayName: "John Johnson",
    address: "0x1234567893123456789312345678931234567893",
  },
];

Deno.test("cron mint", async () => {
  let txCount = 0;

  for (const role of roles) {
    // const users = await discord?.getMembers(role.id);
    if (!users) {
      console.error(`Users not found for role ${role.id}`);
      continue;
    }
    if (txCount > 2) break;
    for (const user of users) {
      const userAddress = getAccountAddressFromDiscordUserId(user.id);
      if (!userAddress) {
        console.error(`User address not found for user ${user.id}`);
        return;
      }
      if (role.mintAmount) {
        console.log(
          `Minting ${role.mintAmount} tokens for user ${user.displayName} for their ${role.name} role`,
        );
        const initialBalance = await getBalance("localhost", contractAddress, userAddress);
        const hash = await mintTokens(
          "localhost",
          contractAddress,
          userAddress,
          role.mintAmount.toString(),
        );

        expect(hash).toBeDefined();

        const newBalance = await getBalance("localhost", contractAddress, userAddress);
        expect(newBalance).toEqual(
          initialBalance + parseUnits(role.mintAmount.toString(), community.primary_token.decimals),
        );

        txCount++;
      }
    }
  }
});

Deno.test("cron burn", async () => {
  let txCount = 0;

  for (const role of roles) {
    // const users = await discord?.getMembers(role.id);
    if (txCount > 2) return;
    if (!users) {
      console.error(`Users not found for role ${role.id}`);
      continue;
    }
    for (const user of users) {
      const userAddress = getAccountAddressFromDiscordUserId(user.id);
      if (!userAddress) {
        console.error(`User address not found for user ${user.id}`);
        return;
      }
      if (txCount === 0) {
        // ensure enough balance to burn
        await mintTokens(
          "localhost",
          contractAddress,
          userAddress,
          (role.burnAmount! * 2).toString(),
        );
        if (role.burnAmount) {
          const initialBalance = await getBalance("localhost", contractAddress, userAddress);
          const hash = await burnTokensFrom(
            "localhost",
            contractAddress,
            userAddress,
            role.burnAmount.toString(),
          );
          expect(hash).toBeDefined();

          const newBalance = await getBalance("localhost", contractAddress, userAddress);
          expect(newBalance).toEqual(
            initialBalance -
              parseUnits(role.burnAmount.toString(), community.primary_token.decimals),
          );
        }
      }
      if (txCount === 1) {
        if (role.burnAmount) {
          try {
            await burnTokensFrom(
              "localhost",
              contractAddress,
              userAddress,
              role.burnAmount.toString(),
            );
          } catch (e) {
            expect(e).toBeDefined();
            expect((e as Error).message).toContain("Insufficient balance");
          }
        }
      }
      txCount++;
    }
  }
});
