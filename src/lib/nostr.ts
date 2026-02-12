import { EventTemplate, finalizeEvent, getPublicKey, nip19, SimplePool } from "npm:nostr-tools";
import { getEnv } from "./utils.ts";

const DRY_RUN = getEnv("DRY_RUN") === "true";

type HexString<Length extends number> = `0x${string}` & { length: Length };
export type Address = HexString<42>;

type BitcoinAddress =
  | `1${string}` // Legacy addresses
  | `3${string}` // P2SH addresses
  | `bc1${string}`; // Native SegWit addresses

export type TxHash = HexString<66>;
export type TxId = HexString<64>;
export type ChainId = number;
export type Blockchain = "ethereum" | "bitcoin";
export type AddressType = "address" | "tx";
export type URI =
  | `ethereum:${ChainId}:address:${Address}`
  | `ethereum:${ChainId}:tx:${TxHash}`
  | `bitcoin:address:${BitcoinAddress}`
  | `bitcoin:tx:${TxId}`;

const getKindFromURI = (uri: URI): string => {
  const type = uri.match(/:tx:/) ? "tx" : "address";
  const blockchain = uri.startsWith("bitcoin") ? "bitcoin" : "ethereum";
  return `${blockchain}:${type}`;
};

// Extract hashtags from a text string
// 1. #[kind:value with spaces] format
// 2. #simpletag
// 3. #key:attr format without spaces
export function extractHashtags(text: string): {
  tags: string[][];
  cleanDescription: string;
} {
  const hashtagRegex = /#(?:\[(\w+:[^\]]+)\]|(\w+:(?:[^\s#]+)?|\w+))/g;
  const matches = text.match(hashtagRegex) || [];

  // Remove hashtags from the description
  const cleanDescription = text
    .replace(hashtagRegex, "")
    .replace(/\s+/g, " ")
    .trim();

  const tags = matches.map((tag) => {
    // If the tag starts with #[, we need to extract the content within brackets
    if (tag.startsWith("#[")) {
      const content = tag.slice(2, -1); // Remove #[ and ]
      return [
        content.substring(0, content.indexOf(":")),
        content.substring(content.indexOf(":") + 1),
      ];
    }
    // Handle regular tags
    if (tag.includes(":")) {
      return [
        tag.substring(1, tag.indexOf(":")),
        tag.substring(tag.indexOf(":") + 1),
      ];
    }
    return ["t", tag.substring(1)];
  });

  return { tags, cleanDescription };
}
export class Nostr {
  private static instance: Nostr | null = null;
  private pool: SimplePool;

  private constructor(
    private readonly nsec?: string,
    readonly relays?: string[],
  ) {
    this.nsec = nsec || Deno.env.get("NOSTR_NSEC");
    this.relays = relays || [
      "wss://nostr-pub.wellorder.net",
      "wss://relay.damus.io",
    ];
    this.pool = new SimplePool();

    this.relays.forEach(async (url) => {
      try {
        await this.pool.ensureRelay(url, {
          // Add WebSocket options
          connectionTimeout: 3000, // 3 seconds timeout
        });
        console.log(`>>> NostrProvider connected to ${url}`);
      } catch (err) {
        console.warn(`Failed to connect to ${url}:`, err);
        // Continue with other relays even if one fails
      }
    });
  }

  static getInstance(nsec?: string, relays?: string[]): Nostr {
    if (!nsec && !Deno.env.get("NOSTR_NSEC")) {
      throw new Error(
        "Nostr: No nsec provided to Nostr.getInstance() or as an environment variable",
      );
    }
    if (!Nostr.instance) {
      Nostr.instance = new Nostr(nsec, relays);
    }
    return Nostr.instance;
  }

  getPublicKey() {
    if (!this.nsec) {
      throw new Error("Nostr: No nsec provided");
    }
    const { data: secretKey } = nip19.decode(this.nsec);
    const pubkey = getPublicKey(secretKey as Uint8Array);
    return pubkey;
  }

  getNpub() {
    return nip19.npubEncode(this.getPublicKey());
  }

  async publishMetadata(
    uri: URI,
    { content, tags }: { content: string; tags: string[][] },
  ) {
    // Always extract hashtags from content and merge with provided tags
    const { tags: tagsFromContent, cleanDescription } = extractHashtags(content);
    content = cleanDescription;
    tags = [...tags, ...tagsFromContent];

    const event: EventTemplate = {
      kind: 1111,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags: [["i", uri.toLowerCase()], ["k", getKindFromURI(uri)], ...tags],
    };
    try {
      await this.publish(event);
    } catch (error) {
      console.error("Failed to publish metadata", error, "event:", event);
    }
  }

  async publish(event: EventTemplate) {
    if (!this.nsec) {
      throw new Error("Nostr: No nsec provided");
    }

    // if env is test, just log the event
    if (DRY_RUN) {
      console.log(">>> DRY RUN: Nostr publish:", event.content);
      return;
    }

    const { data: secretKey } = nip19.decode(this.nsec);
    const signedEvent = finalizeEvent(event, secretKey as Uint8Array);
    // console.log(">>> NostrProvider publishing event", signedEvent);
    await Promise.any(this.pool.publish(this.relays!, signedEvent));
  }

  async close() {
    if (this.pool) {
      await this.pool.close(this.relays!);
    }
  }
}
