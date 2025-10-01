import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress } from "viem";

import { mintTokens, burnTokensFrom } from "../../src/lib/blockchain.ts";

describe("TestToken", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  it("mints tokens to recipient (Transfer from zero)", async function () {
    const wallets = await viem.getWalletClients();
    const deployer = wallets[0];
    const alice = wallets[1];

    const token = await viem.deployContract("TestToken", ["Test Token", "TT"]);

    const amount = 100n;

    const res = await mintTokens(
      { publicClient, walletClient: deployer },
      token.address,
      alice.account.address,
      amount.toString()
    );

    assert.ok(res?.hash);
    assert.equal(await token.read.balanceOf([alice.account.address]), amount);
  });

  it("should fail if not minter role", async function () {
    const wallets = await viem.getWalletClients();
    const deployer = wallets[0];
    const alice = wallets[1];
    const token = await viem.deployContract("TestToken", ["Test Token", "TT"]);

    await assert.rejects(
      mintTokens(
        { publicClient, walletClient: alice },
        token.address,
        alice.account.address,
        "100"
      ),
      new Error(
        `Signer (${getAddress(
          alice.account.address
        )}) does not have the MINTER_ROLE on token contract ${getAddress(
          token.address
        )}`
      )
    );

    // Ensure that deployer can still mint
    await mintTokens(
      { publicClient, walletClient: deployer },
      token.address,
      alice.account.address,
      "50"
    );
    assert.equal(await token.read.balanceOf([alice.account.address]), 50n);
  });

  it("burns tokens from holder via burnFrom (spender needs allowance)", async function () {
    const wallets = await viem.getWalletClients();
    const deployer = wallets[0];
    const alice = wallets[1];

    const token = await viem.deployContract("TestToken", ["Test Token", "TT"]);

    // Mint to Alice first
    await token.write.mint([alice.account.address, 100n]);

    // Alice approves deployer to spend/burn 60 tokens
    await token.write.approve([deployer.account.address, 60n], {
      account: alice.account,
    });

    // burnFrom by deployer should emit Transfer(alice -> zero) for 50
    await viem.assertions.emitWithArgs(
      token.write.burnFrom([alice.account.address, 50n]),
      token,
      "Transfer",
      [getAddress(alice.account.address), ZERO_ADDRESS, 50n]
    );

    // Alice balance decreased
    assert.equal(await token.read.balanceOf([alice.account.address]), 50n);
    // Remaining allowance is 10
    assert.equal(
      await token.read.allowance([
        alice.account.address,
        deployer.account.address,
      ]),
      10n
    );
  });

  it("retries on timeout and succeeds on second try", async function () {
    const wallets = await viem.getWalletClients();
    const deployer = wallets[0];
    const alice = wallets[1];

    const token = await viem.deployContract("TestToken", ["Test Token", "TT"]);

    const originalWrite = deployer.writeContract.bind(deployer);
    let callCount = 0;
    // First call: simulate long-running call that times out (no real tx sent)
    (deployer as any).writeContract = async function (_args: any) {
      callCount++;
      if (callCount === 1) {
        return await new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                // fake hash
                "0x" + "1".repeat(64)
              ),
            50
          )
        );
      }
      return await originalWrite(_args);
    };

    const res = await mintTokens(
      { publicClient, walletClient: deployer },
      token.address,
      alice.account.address,
      "25",
      undefined,
      { timeoutMs: 10 }
    );

    // Restore
    (deployer as any).writeContract = originalWrite;

    assert.ok(res?.hash);
    assert.equal(callCount >= 2, true);
    assert.equal(await token.read.balanceOf([alice.account.address]), 25n);
  });

  it("retries on -32000 error and succeeds on second try", async function () {
    const wallets = await viem.getWalletClients();
    const deployer = wallets[0];
    const alice = wallets[1];

    const token = await viem.deployContract("TestToken", ["Test Token", "TT"]);

    const originalWrite = deployer.writeContract.bind(deployer);
    let callCount = 0;
    (deployer as any).writeContract = async function (args: any) {
      callCount++;
      if (callCount === 1) {
        const err: any = new Error(
          "insufficient funds for gas * price + value"
        );
        err.code = -32000;
        throw err;
      }
      return await originalWrite(args);
    };

    const res = await mintTokens(
      { publicClient, walletClient: deployer },
      token.address,
      alice.account.address,
      "30"
    );

    // Restore
    (deployer as any).writeContract = originalWrite;

    assert.ok(res?.hash);
    assert.equal(callCount >= 2, true);
    assert.equal(await token.read.balanceOf([alice.account.address]), 30n);
  });
});
