import { TransactionReceipt } from "@wevm/viem";
import { dirname } from "@std/path";

let txCache: { [key: string]: TransactionReceipt | null } | null = null;

const CACHE_JSON_FILEPATH = "./cache/cache.json";

// Make sure the cache directory and file exist
try {
  Deno.statSync(CACHE_JSON_FILEPATH);
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    Deno.mkdirSync(dirname(CACHE_JSON_FILEPATH), { recursive: true });
    Deno.writeTextFileSync(CACHE_JSON_FILEPATH, "{}");
  } else {
    throw error;
  }
}

export function readCache(): { [key: string]: TransactionReceipt | null } {
  if (txCache) return txCache;
  try {
    if (
      typeof Deno !== "undefined" &&
      typeof Deno.readTextFileSync === "function"
    ) {
      const cacheJson = Deno.readTextFileSync(CACHE_JSON_FILEPATH);
      txCache = JSON.parse(cacheJson) as {
        [key: string]: TransactionReceipt | null;
      };
      return txCache;
    }
  } catch {
    // ignore
  }
  try {
    // Node fallback
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    if (fs.existsSync(CACHE_JSON_FILEPATH)) {
      const cacheJson = fs.readFileSync(CACHE_JSON_FILEPATH, "utf8");
      txCache = JSON.parse(cacheJson) as {
        [key: string]: TransactionReceipt | null;
      };
      return txCache;
    }
  } catch {
    // ignore
  }
  txCache = {};
  return txCache;
}

export function writeCache(cache: {
  [key: string]: TransactionReceipt | null;
}) {
  try {
    if (!cache) return;
    if (
      typeof Deno !== "undefined" &&
      typeof Deno.writeTextFileSync === "function"
    ) {
      Deno.writeTextFileSync(CACHE_JSON_FILEPATH, JSON.stringify(cache, null, 2));
      return;
    }
  } catch {
    // ignore
  }
  try {
    // Node fallback
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    fs.writeFileSync(CACHE_JSON_FILEPATH, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // ignore
  }
}
