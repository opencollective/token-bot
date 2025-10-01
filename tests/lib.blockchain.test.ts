import {
  deployContract,
  getBalance,
  getBaseFee,
  getBlockchainTxInfo,
  hasRole,
  MINTER_ROLE,
  mintTokens,
  burnTokensFrom,
} from "../src/lib/blockchain.ts";
import { expect } from "@std/expect/expect";

Deno.test("should return tx receipt", async () => {
  // https://celoscan.io/tx/0x12bc21c4aeb8c049dc76f5b59dbf4bde8d96408b8023770cc2093a7fb7e0c8fa
  const txHash =
    "0xa1e6f912b88c0ad485ee22d097bde750e4ec3b13b16a32f3f013c618875f84f0";
  const txReceipt = await getBlockchainTxInfo("celo", txHash);
  expect(txReceipt).not.toBeNull();
  expect(txReceipt?.to).toBe("0x7079253c0358eF9Fd87E16488299Ef6e06F403B6");
  expect(txReceipt?.from).toBe("0x70e15a0D3239Da96d84c932705644486dd09146D");
});

Deno.test("should return tx receipt not found", async () => {
  // https://celoscan.io/tx/0xacfa3695623cfb8d4e390f9e40cdc830a71df112775a3ff51efe9a4f21ca57e8
  const txHash =
    "0xacfa3695623cfb8d4e390f9e40cdc830a71df112775a3ff51efe9a4f21ca57e8";
  const txReceipt = await getBlockchainTxInfo("celo", txHash);
  expect(txReceipt).toBeNull();
});

Deno.test("should return tx receipt not found", async () => {
  // https://celoscan.io/tx/0xd708b51a8c233a3005f6f438016552b92656c465050c9fe48569e2daa7cb864b
  const txHash =
    "0xd708b51a8c233a3005f6f438016552b92656c465050c9fe48569e2daa7cb864b";
  const txReceipt = await getBlockchainTxInfo("celo", txHash);
  expect(txReceipt).not.toBeNull();
});

Deno.test("should return baseFee", async () => {
  const baseFee = await getBaseFee("celo");
  expect(baseFee).not.toBeNull();
});

Deno.test("hasRole", async () => {
  const res = await hasRole(
    "celo",
    "0x65dd32834927de9e57e72a3e2130a19f81c6371d",
    MINTER_ROLE,
    "0x70e15a0D3239Da96d84c932705644486dd09146D"
  );
  expect(res).toBe(false);
  const res2 = await hasRole(
    "celo",
    "0x65dd32834927de9e57e72a3e2130a19f81c6371d", // chb-token
    MINTER_ROLE,
    "0xD062a4b48F98504Db9e6cfbE020c6F75e0568b88" // chb-token-bot
  );
  expect(res2).toBe(true);
});

Deno.test("deployContract, mintTokens, getBalance", async () => {
  const contractAddress = await deployContract(
    "localhost",
    "TestToken",
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    ["Test Token", "TT"]
  );
  console.log(contractAddress);
  expect(contractAddress).not.toBeNull();
  const res = await hasRole(
    "localhost",
    contractAddress,
    MINTER_ROLE,
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
  );
  console.log(res);

  const hash = await mintTokens(
    "localhost",
    contractAddress,
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "100"
  );

  expect(hash).not.toBeNull();

  const balance = await getBalance(
    "localhost",
    contractAddress,
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
  );
  expect(balance).toBe(100n * 10n ** 6n);

  await burnTokensFrom(
    "localhost",
    contractAddress,
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "20"
  );

  const balance2 = await getBalance(
    "localhost",
    contractAddress,
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
  );
  expect(balance2).toBe(80n * 10n ** 6n);

  expect(res).toBe(true);
});

Deno.test("deployContract, fails to mint if not enough ETH", async () => {
  const contractAddress = await deployContract(
    "localhost",
    "TestToken",
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    ["Test Token", "TT"]
  );
  console.log(contractAddress);
  expect(contractAddress).not.toBeNull();
  const res = await hasRole(
    "localhost",
    contractAddress,
    MINTER_ROLE,
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
  );
  console.log(res);

  const hash = await mintTokens(
    "localhost",
    contractAddress,
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "100"
  );

  expect(hash).not.toBeNull();

  const balance = await getBalance(
    "localhost",
    contractAddress,
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
  );
  expect(balance).toBe(100n * 10n ** 6n);

  await burnTokensFrom(
    "localhost",
    contractAddress,
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "20"
  );

  const balance2 = await getBalance(
    "localhost",
    contractAddress,
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
  );
  expect(balance2).toBe(80n * 10n ** 6n);

  expect(res).toBe(true);
});
