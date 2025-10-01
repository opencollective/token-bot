import { network } from "hardhat";
import { isAddress, parseEther } from "viem";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function readAccountAddressFromEnv(): string | undefined {
  // Resolve path relative to the Hardhat project root. When this autorun script
  // executes, process.cwd() should be the hardhat/ directory; ../.env.test is at repo root.
  const envPath = resolve(process.cwd(), "../.env.test");
  if (!existsSync(envPath)) {
    console.warn(`@faucet: Skipping faucet. Env file not found at ${envPath}`);
    return undefined;
  }

  const content = readFileSync(envPath, { encoding: "utf8" });
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split("=");
    if (key.trim() === "ACCOUNT_ADDRESS") {
      const value = rest
        .join("=")
        .trim()
        .replace(/^['\"]|['\"]$/g, "");
      return value;
    }
  }
  return undefined;
}

const recipient = readAccountAddressFromEnv();

if (!recipient) {
  console.warn("@faucet: ACCOUNT_ADDRESS not provided. Set it in ../.env.test");
} else if (!isAddress(recipient)) {
  console.warn(
    `@faucet: Invalid ACCOUNT_ADDRESS '${recipient}'. Skipping faucet.`
  );
} else {
  const { viem } = await network.connect();

  const publicClient = await viem.getPublicClient();
  const [senderClient] = await viem.getWalletClients();

  if (!senderClient) {
    console.warn(
      "@faucet: No local wallet available to fund recipient. Skipping."
    );
  } else {
    try {
      const amountWei = parseEther("10");
      console.log(
        `@faucet: Sending ${amountWei} wei (10 ETH) to ${recipient} from ${senderClient.account.address}`
      );

      const txHash = await senderClient.sendTransaction({
        to: recipient,
        value: amountWei,
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      console.log(`@faucet: Funded ${recipient}. Tx: ${txHash}`);
    } catch (error) {
      console.error("@faucet: Failed to fund recipient:", error);
    }
  }
}
