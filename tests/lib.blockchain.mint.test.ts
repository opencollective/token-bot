import { expect } from "@std/expect/expect";
import { burnTokensFrom, deployContract, getBalance, mintTokens } from "../src/lib/blockchain.ts";
import { parseUnits } from "@wevm/viem";
import { privateKeyToAccount } from "@wevm/viem/accounts";
import { beforeAll } from "@std/testing/bdd";

const privateKey = Deno.env.get("PRIVATE_KEY")! as `0x${string}`;

beforeAll(async () => {});

Deno.test(
  {
    name: "mintTokens and burnTokens work on local Hardhat",
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
  },
  async () => {
    const tokenAddress = await deployContract(
      "localhost",
      "BurnableToken",
      ["Test Token", "TT"],
    );

    const account = privateKeyToAccount(privateKey);
    console.log("Account", account.address);
    console.log("Token Address", tokenAddress);

    // Balance before
    const before = await getBalance(
      "localhost",
      tokenAddress!,
      account.address,
    );

    // 4) Mint 1.5 tokens
    const mintAmount = "1.5";
    const txHash = await mintTokens(
      "localhost",
      tokenAddress!,
      account.address,
      mintAmount,
    );
    expect(txHash).not.toBeNull();

    const afterMint = await getBalance(
      "localhost",
      tokenAddress!,
      account.address,
    );
    expect(afterMint).toEqual(before + parseUnits(mintAmount, 6));

    // 5) Burn 0.5 tokens
    const burnAmount = "0.5";
    const txBurn = await burnTokensFrom(
      "localhost",
      tokenAddress!,
      account.address,
      burnAmount,
    );
    expect(txBurn).not.toBeNull();

    const afterBurn = await getBalance(
      "localhost",
      tokenAddress!,
      account.address,
    );
    expect(afterBurn).toEqual(afterMint - parseUnits(burnAmount, 6));
  },
);
