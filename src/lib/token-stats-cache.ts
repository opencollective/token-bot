import { formatUnits } from "@wevm/viem";
import { getTokenHolderCount, getTotalSupply, type SupportedChain } from "./blockchain.ts";
import { loadGuildSettings, getEnv } from "./utils.ts";
import type { Chain } from "../types.ts";

type TokenStats = { totalSupply: string; holders: number | null };

const cache = new Map<string, TokenStats>();

function cacheKey(chain: Chain, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

async function fetchLive(chain: Chain, address: string, decimals: number): Promise<TokenStats> {
  try {
    const [totalSupplyRaw, holders] = await Promise.all([
      getTotalSupply(chain as SupportedChain, address),
      getTokenHolderCount(chain as SupportedChain, address),
    ]);
    const totalSupply = formatUnits(totalSupplyRaw, decimals);
    const formattedSupply = Math.floor(parseFloat(totalSupply)).toLocaleString("en-US");
    return { totalSupply: formattedSupply, holders };
  } catch (error) {
    console.error(`Error fetching token stats for ${address}:`, error);
    return { totalSupply: "?", holders: null };
  }
}

/** Get stats from cache, fall back to live fetch on miss */
export async function getTokenStats(chain: Chain, address: string, decimals: number): Promise<TokenStats> {
  const key = cacheKey(chain, address);
  const cached = cache.get(key);
  if (cached) return cached;

  const stats = await fetchLive(chain, address, decimals);
  cache.set(key, stats);
  return stats;
}

/** Refresh a single token's stats (call after mint/burn) */
export async function refreshTokenStats(chain: Chain, address: string, decimals: number): Promise<void> {
  const stats = await fetchLive(chain, address, decimals);
  cache.set(cacheKey(chain, address), stats);
}

/** Warm cache for all configured tokens */
export async function warmTokenStatsCache(): Promise<void> {
  const dataDir = getEnv("DATA_DIR") || "./data";
  try {
    for await (const entry of Deno.readDir(dataDir)) {
      if (!entry.isDirectory) continue;
      const settings = await loadGuildSettings(entry.name);
      if (!settings?.tokens) continue;
      await Promise.all(
        settings.tokens.map((token) => fetchLive(token.chain, token.address, token.decimals).then((stats) => {
          cache.set(cacheKey(token.chain, token.address), stats);
        })),
      );
    }
    console.log(`📊 Token stats cache warmed (${cache.size} tokens)`);
  } catch (error) {
    console.error("Token stats cache warm failed:", error);
  }
}
