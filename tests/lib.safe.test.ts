import { expect } from "@std/expect/expect";
import { beforeAll } from "@std/testing/bdd";
import { deploySAFE, getSAFEAddress } from "../src/lib/safe.ts";
import { createPublicClient, http } from "@wevm/viem";
import { ChainConfig, RPC_URLS } from "../src/lib/blockchain.ts";
import type { Address } from "@wevm/viem";

const TEST_DISCORD_USER_ID_1 = "1234567890";
const TEST_DISCORD_USER_ID_2 = "9876543210";
const SAFE_PROXY_FACTORY_ADDRESS = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address;

let safeContractsDeployed = false;

beforeAll(async () => {
  // Ensure we're testing on localhost
  const chain = Deno.env.get("CHAIN");
  if (chain !== "localhost") {
    console.warn(
      `Warning: Tests should run on localhost, but CHAIN is set to ${chain}`,
    );
  }

  // Check if Safe contracts are deployed
  const publicClient = createPublicClient({
    chain: ChainConfig["localhost"],
    transport: http(RPC_URLS["localhost"]),
  });

  const code = await publicClient.getCode({ address: SAFE_PROXY_FACTORY_ADDRESS });
  safeContractsDeployed = code !== undefined && code !== "0x";

  if (!safeContractsDeployed) {
    console.warn("⚠️  Safe contracts are NOT deployed on localhost");
    console.warn("   Deployment tests will be skipped");
    console.warn("   To deploy Safe contracts, see: https://docs.safe.global/");
  } else {
    console.log("✅ Safe contracts are deployed on localhost");
  }
});

Deno.test(
  {
    name: "getSAFEAddress returns deterministic address for same Discord user ID",
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
  },
  () => {
    const address1 = getSAFEAddress(TEST_DISCORD_USER_ID_1, "localhost");
    const address2 = getSAFEAddress(TEST_DISCORD_USER_ID_1, "localhost");

    expect(address1).toBe(address2);
    expect(address1).toMatch(/^0x[a-fA-F0-9]{40}$/);

    console.log(`✓ Deterministic address for user ${TEST_DISCORD_USER_ID_1}: ${address1}`);
  },
);

Deno.test(
  {
    name: "getSAFEAddress returns different addresses for different Discord user IDs",
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
  },
  () => {
    const address1 = getSAFEAddress(TEST_DISCORD_USER_ID_1, "localhost");
    const address2 = getSAFEAddress(TEST_DISCORD_USER_ID_2, "localhost");

    expect(address1).not.toBe(address2);

    console.log(`✓ User ${TEST_DISCORD_USER_ID_1} -> ${address1}`);
    console.log(`✓ User ${TEST_DISCORD_USER_ID_2} -> ${address2}`);
  },
);

Deno.test(
  {
    name: "getSAFEAddress returns valid Ethereum address format",
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
  },
  () => {
    const testIds = ["user1", "user2", "123", "discord_id_12345", "0"];

    for (const userId of testIds) {
      const address = getSAFEAddress(userId, "localhost");
      expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    }

    console.log(`✓ All ${testIds.length} test IDs generated valid addresses`);
  },
);

Deno.test(
  {
    name: "getSAFEAddress works with different environment variables",
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
  },
  () => {
    // This test verifies that the function correctly reads from env variables
    const pk = Deno.env.get("PRIVATE_KEY");
    const backupPk = Deno.env.get("BACKUP_PRIVATE_KEY");

    expect(pk).toBeDefined();
    expect(backupPk).toBeDefined();
    expect(pk).not.toBe(backupPk);

    // Should not throw
    const address = getSAFEAddress("test_user", "localhost");
    expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);

    console.log(`✓ Using PRIVATE_KEY: ${pk?.slice(0, 10)}...`);
    console.log(`✓ Using BACKUP_PRIVATE_KEY: ${backupPk?.slice(0, 10)}...`);
    console.log(`✓ Generated Safe address: ${address}`);
  },
);

Deno.test(
  {
    name: "getSAFEAddress throws error without required environment variables",
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
  },
  () => {
    // Save original env vars
    const originalPk = Deno.env.get("PRIVATE_KEY");
    const originalBackupPk = Deno.env.get("BACKUP_PRIVATE_KEY");

    try {
      // Test without PRIVATE_KEY
      Deno.env.delete("PRIVATE_KEY");
      expect(() => getSAFEAddress("test", "localhost")).toThrow("PRIVATE_KEY");

      // Restore PRIVATE_KEY
      if (originalPk) Deno.env.set("PRIVATE_KEY", originalPk);

      // Test without BACKUP_PRIVATE_KEY
      Deno.env.delete("BACKUP_PRIVATE_KEY");
      expect(() => getSAFEAddress("test", "localhost")).toThrow("BACKUP_PRIVATE_KEY");

      console.log("✓ Properly validates required environment variables");
    } finally {
      // Restore all env vars
      if (originalPk) Deno.env.set("PRIVATE_KEY", originalPk);
      if (originalBackupPk) Deno.env.set("BACKUP_PRIVATE_KEY", originalBackupPk);
    }
  },
);

// These tests require Safe contracts to be deployed
Deno.test(
  {
    name: "deploySAFE deploys a Safe successfully (requires Safe contracts)",
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    ignore: !safeContractsDeployed,
  },
  async () => {
    const discordUserId = `test_deploy_${Date.now()}_${Math.random()}`;
    const predictedAddress = getSAFEAddress(discordUserId, "localhost");

    console.log(`Deploying Safe for Discord user ${discordUserId}`);
    console.log(`Predicted address: ${predictedAddress}`);

    // Deploy the Safe
    const deployedAddress = await deploySAFE(discordUserId, "localhost");

    expect(deployedAddress).toBe(predictedAddress);
    console.log(`✓ Safe deployed at ${deployedAddress}`);

    // Verify the Safe was actually deployed by checking code at address
    const publicClient = createPublicClient({
      chain: ChainConfig["localhost"],
      transport: http(RPC_URLS["localhost"]),
    });

    const code = await publicClient.getCode({ address: deployedAddress });
    expect(code).toBeTruthy();
    expect(code).not.toBe("0x");
    console.log(`✓ Verified Safe contract exists at ${deployedAddress}`);
  },
);

Deno.test(
  {
    name: "deploySAFE is idempotent (requires Safe contracts)",
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
    ignore: !safeContractsDeployed,
  },
  async () => {
    const discordUserId = `test_idempotent_${Date.now()}_${Math.random()}`;

    // First deployment
    const address1 = await deploySAFE(discordUserId, "localhost");
    console.log(`First deployment: ${address1}`);

    // Second deployment (should return existing address without deploying again)
    const address2 = await deploySAFE(discordUserId, "localhost");
    console.log(`Second deployment: ${address2}`);

    // Should be the same address
    expect(address1).toBe(address2);

    // Verify the Safe exists
    const publicClient = createPublicClient({
      chain: ChainConfig["localhost"],
      transport: http(RPC_URLS["localhost"]),
    });

    const code = await publicClient.getCode({ address: address1 });
    expect(code).toBeTruthy();
    expect(code).not.toBe("0x");

    console.log(`✓ Verified idempotent deployment: both calls returned ${address1}`);
  },
);

// Informational test that documents the requirements
Deno.test(
  {
    name: "INFO: Safe deployment requirements",
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
  },
  () => {
    console.log("\n📋 Safe Deployment Requirements:");
    console.log("   - Safe contracts must be pre-deployed on the network");
    console.log("   - On production chains (base, celo, gnosis, etc.), Safe is already deployed");
    console.log("   - For localhost testing, deploy Safe contracts first");
    console.log(`   - Safe Proxy Factory: ${SAFE_PROXY_FACTORY_ADDRESS}`);
    console.log(
      `   - Contracts deployed on localhost: ${safeContractsDeployed ? "YES ✅" : "NO ⚠️"}`,
    );

    // This test always passes, it's just for documentation
    expect(true).toBe(true);
  },
);
