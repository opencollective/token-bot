/**
 * Change a transaction's category: a kind 1111 annotation signed by the steward who made the change
 * (their bot-derived member key, attested by the bot with roles member + steward), published to the
 * community relays.
 *
 * chb keeps the newest trusted annotation per transaction as its whole record, so the new event
 * copies the current one (description and tags) and only swaps the category.
 */
import type { Event, EventTemplate, Filter } from "nostr-tools";
import { nip19 } from "nostr-tools";
import { loadGuildFile } from "./utils.ts";
import { type DiscordMember, ShiftsNostr, type ShiftsNostrSettings } from "./shifts-nostr.ts";
import { COMMUNITY_RELAY, Nostr } from "./nostr.ts";

export const KIND_ANNOTATION = 1111;

/**
 * The NIP-73 `k` for a transaction URI, as chb indexes them (docs/annotations.md):
 *   ethereum:<chainId>:tx:0x…          → ethereum:tx
 *   stripe:txn_…                       → stripe:txn
 *   iban:<iban>:tx:<line id>           → iban:tx
 *   odoo:<host>:<db>:account.move:<id> → odoo:account.move
 * Anything else: its scheme.
 */
export function kindOfUri(uri: string): string {
  const m = uri.match(/^(ethereum|bitcoin)(?::\d+)?:(tx|address):/);
  if (m) return `${m[1]}:${m[2]}`;
  if (/^stripe:txn_/i.test(uri)) return "stripe:txn";
  if (/^iban:[^:]+:tx:/i.test(uri)) return "iban:tx";
  const odoo = uri.match(/^odoo:.*:(account\.move):\d+$/i);
  if (odoo) return "odoo:account.move";
  return uri.split(":")[0];
}

/** The newest annotation of a URI (by anyone), or undefined. */
export function newest(events: Event[]): Event | undefined {
  return [...events].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))[0];
}

/**
 * The new annotation: the current one's content and tags, with the category replaced (chb reads
 * "uncategorized" as no category, and "other" as a deliberate choice). Pure, for tests.
 */
export function buildCategoryAnnotation(
  uri: string,
  category: string,
  current: Pick<Event, "content" | "tags"> | undefined,
  now = new Date(),
): EventTemplate {
  const kept = (current?.tags ?? []).filter((t) => !["i", "k", "category"].includes(t[0]));
  return {
    kind: KIND_ANNOTATION,
    created_at: Math.floor(now.getTime() / 1000),
    content: current?.content ?? "",
    tags: [
      ["i", uri.toLowerCase()],
      ["k", kindOfUri(uri)],
      ...kept,
      ["category", category],
    ],
  };
}

async function shiftsNostr(guildId: string, guildName: string): Promise<ShiftsNostr> {
  const settings = await loadGuildFile(guildId, "shifts-settings.json") as { nostr?: ShiftsNostrSettings } | null;
  const sn = ShiftsNostr.forGuild({ guildId, name: guildName }, settings?.nostr);
  if (!sn) throw new Error("Nostr is not configured for this server (NOSTR_NSEC / shifts-settings nostr)");
  return sn;
}

export type CategoryChange = { uri: string; eventId: string; previous: string | null };

/** Publish the category change of each URI, signed by `member`'s key. */
export async function setTransactionCategory(p: {
  guildId: string;
  guildName: string;
  member: DiscordMember;
  uris: string[];
  category: string;
}): Promise<{ changes: CategoryChange[]; npub: string }> {
  const sn = await shiftsNostr(p.guildId, p.guildName);
  const nostr = Nostr.getInstance();
  const member: DiscordMember = p.member; // roles: the member's actual community roles (exact list)
  const changes: CategoryChange[] = [];
  let pubkey = "";
  for (const uri of p.uris) {
    const filter: Filter = { kinds: [KIND_ANNOTATION], "#i": [uri.toLowerCase()] };
    const current = newest(await nostr.query(filter, 5000, [COMMUNITY_RELAY]).catch(() => []));
    const previous = current?.tags.find((t) => t[0] === "category")?.[1] ?? null;
    const { event, pubkey: pk } = await sn.publishAsMember(member, buildCategoryAnnotation(uri, p.category, current));
    pubkey = pk;
    changes.push({ uri, eventId: event.id, previous });
  }
  return { changes, npub: pubkey ? nip19.npubEncode(pubkey) : "" };
}

/** Current category of a URI on the community relay (newest annotation), or null. */
export async function currentCategory(uri: string): Promise<string | null> {
  const events = await Nostr.getInstance().query({ kinds: [KIND_ANNOTATION], "#i": [uri.toLowerCase()] }, 5000, [COMMUNITY_RELAY]).catch(() => []);
  return newest(events)?.tags.find((t) => t[0] === "category")?.[1] ?? null;
}
