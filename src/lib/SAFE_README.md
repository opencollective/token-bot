# Gnosis SAFE Integration

This module provides easy-to-use functions for interacting with Gnosis SAFE, enabling deterministic Safe address generation and deployment.

## Features

- ✅ **Deterministic Address Generation**: Map Discord user IDs to Safe addresses in a deterministic way
- ✅ **Idempotent Deployment**: Deploy Safes that won't be re-deployed if they already exist
- ✅ **Viem Integration**: Uses viem for all blockchain interactions (no ethers.js)
- ✅ **Multi-chain Support**: Works with any chain supported by the project (base, celo, gnosis, polygon, etc.)

## Functions

### `getSAFEAddress(discordUserId: string, chainSlug?: SupportedChain): Address`

Generates a deterministic Safe address for a Discord user ID without deploying anything.

**Parameters:**
- `discordUserId` - The Discord user ID to generate a Safe address for
- `chainSlug` - (Optional) The blockchain network (defaults to `CHAIN` env var)

**Returns:** `Address` - The predicted Safe address (counterfactual address)

**Example:**
```typescript
import { getSAFEAddress } from "./src/lib/safe.ts";

const userSafeAddress = getSAFEAddress("1234567890", "base");
console.log(`User's Safe will be deployed at: ${userSafeAddress}`);
```

### `deploySAFE(discordUserId: string, chainSlug?: SupportedChain): Promise<Address>`

Deploys a Safe multisig for a Discord user ID. This function is **idempotent** - if the Safe already exists, it returns the existing address.

**Configuration:**
- **Owners**: `PRIVATE_KEY` address and `BACKUP_PRIVATE_KEY` address
- **Threshold**: 1 (either owner can sign transactions)
- **Deployer**: `PRIVATE_KEY` account (pays gas fees)

**Parameters:**
- `discordUserId` - The Discord user ID to deploy a Safe for
- `chainSlug` - (Optional) The blockchain network (defaults to `CHAIN` env var)

**Returns:** `Promise<Address>` - The deployed Safe address

**Example:**
```typescript
import { deploySAFE } from "./src/lib/safe.ts";

// First call: deploys the Safe
const safeAddress = await deploySAFE("1234567890", "base");
console.log(`Safe deployed at: ${safeAddress}`);

// Second call: returns existing Safe address
const sameSafeAddress = await deploySAFE("1234567890", "base");
console.log(`Safe already exists at: ${sameSafeAddress}`);
```

## Environment Variables

Required environment variables:

- `PRIVATE_KEY` - Primary private key (owner 1 of the Safe)
- `BACKUP_PRIVATE_KEY` - Backup private key (owner 2 of the Safe)
- `CHAIN` - (Optional) Default blockchain network (e.g., "base", "celo", "gnosis")

**Example `.env`:**
```bash
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
BACKUP_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
CHAIN=base
```

## Requirements

### Safe Contracts Deployment

The Safe contracts **must be pre-deployed on the network** for deployment to work:

- ✅ **Production chains** (base, celo, gnosis, polygon, base_sepolia): Safe contracts are already deployed
- ⚠️ **Localhost/Hardhat**: You need to deploy Safe contracts first

**Safe Contract Addresses (v1.4.1):**
- Safe Proxy Factory: `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`
- Safe Singleton: `0x41675C099F32341bf84BFc5382aF534df5C7461a`
- Fallback Handler: `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`

For local development with Hardhat, see [Safe Deployment Guide](https://docs.safe.global/advanced/smart-account-deployment).

## Testing

Run the tests:

```bash
# Run Safe tests
deno task test:safe

# Run all tests
deno test --allow-net --allow-env --env-file=.env.test --allow-read --allow-write
```

**Note:** Deployment tests require Safe contracts to be deployed on the test network. If running on localhost without Safe contracts, deployment tests will be skipped.

## How It Works

### Deterministic Address Generation

1. Discord user ID is hashed using keccak256 to create a deterministic salt
2. Safe owners are sorted (PRIVATE_KEY address, BACKUP_PRIVATE_KEY address)
3. Safe setup parameters are encoded (owners, threshold=1, fallback handler)
4. CREATE2 address is calculated using:
   - Safe Proxy Factory address
   - Deployment bytecode with singleton address
   - Salt derived from user ID

### Deployment Process

1. Calculate predicted Safe address using `getSAFEAddress()`
2. Check if Safe already exists at that address using `getCode()`
3. If exists: return existing address (idempotent behavior)
4. If not exists: deploy via Safe Proxy Factory's `createProxyWithNonce()`
5. Return deployed Safe address

## Security Considerations

- 🔐 **Private Keys**: Never commit private keys to version control
- 🔐 **Environment Variables**: Use `.env` files and keep them out of git
- 🔐 **Threshold**: Current implementation uses 1-of-2 multisig (either key can sign)
- 🔐 **Backup Key**: Keep `BACKUP_PRIVATE_KEY` secure and separate from `PRIVATE_KEY`

## Use Cases

- **Discord Bot Wallets**: Each Discord user gets their own Safe multisig
- **Custodial Services**: Create user-specific Safes with backup recovery
- **DAO Tools**: Deterministic Safe addresses for community members
- **Gaming**: Per-user wallets with backup keys for asset recovery

## References

- [Safe Documentation](https://docs.safe.global/)
- [Safe Protocol Kit](https://github.com/safe-global/safe-core-sdk)
- [Viem Documentation](https://viem.sh/)



