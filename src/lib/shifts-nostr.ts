/**
 * Shifts on Nostr — the bot's side of the conventions published at
 * https://commonshub.brussels/docs/nostr.md (which follow commonshub.dev/docs).
 *
 * The community relays are the record of who takes which caretaking shift;
 * the Discord /shifts command, the website's day pages and Elinor all read
 * and write the same events:
 *
 *   - kind 34550  community definition, one per Discord server (d = dc<guild>)
 *   - kind 31923  shift occurrence, one per day and slot, signed by the
 *                 coordinator (this bot): d = shift-<guild>-<YYYY-MM-DD>-<HHMM>
 *   - kind 31925  RSVP, signed by the member's key: status accepted/declined,
 *                 newest per (attendee, slot) wins, so cancelling = republishing
 *                 as declined
 *   - kind 31926  identity attestation by an identity provider: d = discord:<id>,
 *                 one p tag per key that belongs to that member
 *   - kind 0      the member key's profile, with a NIP-39 ["i","discord:<id>"] claim
 *
 * Discord members do not hold Nostr keys, so the bot derives one key per
 * member from its own secret (deterministic, never stored) and attests it
 * under the bot's key. The website does the same with browser-held keys and
 * attests those under the site's key; both apps trust each other's
 * attestations, so a member signed up in one place is the same member in the
 * other. The relay accepts writes from attested keys of allow-listed
 * providers, which is why the bot's key must be on the relay allow-list.
 *
 * Everything that does not touch the network is pure and exported for tests.
 */

import { finalizeEvent, getPublicKey, nip19, SimplePool, type Event, type EventTemplate, type Filter } from "nostr-tools";
import { getEnv } from "./utils.ts";

export const KIND_PROFILE = 0;
export const KIND_SHIFT = 31923;
export const KIND_RSVP = 31925;
export const KIND_ATTESTATION = 31926;
export const KIND_COMMUNITY = 34550;

export const APP_NAME = "token-bot";
export const DEFAULT_RELAYS = ["wss://relay.commonshub.brussels", "wss://relay.commonshub.dev"];
/** The website's identity endpoint: tells us the site's pubkey, a trusted identity provider. */
export const SITE_IDENTITY_URL = "https://commonshub.brussels/api/nostr/identity";
/** commonshub.brussels site key, used until the identity endpoint has been reached. */
export const KNOWN_SITE_PUBKEY = "727bdf54ac689a75cf875446dd242091d6ebfc199bd58fce1c668f8405183492";

export interface ShiftSlot {
  start: string;
  end: string;
}

export interface ShiftsNostrSettings {
  /** Relays to publish to and read from; the first is the primary. */
  relays?: string[];
  /** Coordinator of the shift occurrences. Default: this bot. */
  coordinatorNpub?: string;
  /** Extra identity providers (npubs) whose attestations we trust, besides the bot and the site. */
  identityProviders?: string[];
  /** Set to false to disable Nostr for shifts entirely. */
  enabled?: boolean;
}

export interface Community {
  guildId: string;
  name: string;
}

export interface DiscordMember {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
}

// ── pure helpers ───────────────────────────────────────────────────────────

const tag = (event: { tags: string[][] }, name: string) => event.tags.find((t) => t[0] === name)?.[1];
const tagsOf = (event: { tags: string[][] }, name: string) => event.tags.filter((t) => t[0] === name).map((t) => t[1]);
export const nowSeconds = (now = new Date()) => Math.floor(now.getTime() / 1000);

export const slotCode = (slot: ShiftSlot) => slot.start.replace(":", "");
export const slotLabel = (slot: ShiftSlot) => `${slot.start}–${slot.end}`;
export const communityD = (community: Community) => `dc${community.guildId}`;
export const communityCoordinate = (coordinator: string, community: Community) => `${KIND_COMMUNITY}:${coordinator}:${communityD(community)}`;
export const shiftD = (community: Community, day: string, slot: ShiftSlot) => `shift-${community.guildId}-${day}-${slotCode(slot)}`;
export const shiftCoordinate = (coordinator: string, community: Community, day: string, slot: ShiftSlot) =>
  `${KIND_SHIFT}:${coordinator}:${shiftD(community, day, slot)}`;

/** YYYY-MM-DD of a Date in a timezone. */
export function dayString(date: Date, timezone = "Europe/Brussels"): string {
  return date.toLocaleDateString("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Seconds since epoch for "HH:MM" on `day` in Brussels (UTC+1, UTC+2 in summer). */
export function brusselsInstant(day: string, hhmm: string): number {
  for (const offset of ["+02:00", "+01:00"]) {
    const date = new Date(`${day}T${hhmm}:00${offset}`);
    const local = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" });
    if (local === hhmm) return Math.floor(date.getTime() / 1000);
  }
  return Math.floor(new Date(`${day}T${hhmm}:00+01:00`).getTime() / 1000);
}

/** Tags every event from the bot carries: the community and the app (NIP-89 client + t for filtering). */
export function baseTags(community: Community, botPubkey: string): string[][] {
  return [
    ["i", `discord:${community.guildId}`],
    ["k", "discord"],
    ["client", APP_NAME, `31990:${botPubkey}:discord`],
    ["t", `app:${APP_NAME}`],
  ];
}

export function buildCommunityDefinition(community: Community, botPubkey: string, description: string, now = new Date()): EventTemplate {
  return {
    kind: KIND_COMMUNITY,
    created_at: nowSeconds(now),
    tags: [["d", communityD(community)], ["name", community.name], ["description", description], ...baseTags(community, botPubkey)],
    content: "",
  };
}

export function buildShiftOccurrence(
  community: Community,
  botPubkey: string,
  day: string,
  slot: ShiftSlot,
  capacity: number,
  title: string,
  now = new Date(),
): EventTemplate {
  return {
    kind: KIND_SHIFT,
    created_at: nowSeconds(now),
    tags: [
      ["d", shiftD(community, day, slot)],
      ["title", title],
      ["start", String(brusselsInstant(day, slot.start))],
      ["end", String(brusselsInstant(day, slot.end))],
      ["start_tzid", "Europe/Brussels"],
      ["capacity", String(capacity)],
      ["t", "shift"],
      ["t", slotCode(slot)],
      ["t", `group-${community.guildId}`],
      ["a", communityCoordinate(botPubkey, community)],
      ...baseTags(community, botPubkey),
    ],
    content: `${title} on ${day}, ${slotLabel(slot)}`,
  };
}

/** The member's RSVP, to be signed with the member's (bot-derived) key. */
export function buildRsvp(
  action: "signup" | "cancel",
  community: Community,
  coordinator: string,
  botPubkey: string,
  day: string,
  slot: ShiftSlot,
  now = new Date(),
): EventTemplate {
  return {
    kind: KIND_RSVP,
    created_at: nowSeconds(now),
    tags: [
      ["a", shiftCoordinate(coordinator, community, day, slot)],
      ["d", `rsvp-${community.guildId}-${day}-${slotCode(slot)}`],
      ["status", action === "signup" ? "accepted" : "declined"],
      ["p", coordinator],
      ["t", "shift"],
      ...baseTags(community, botPubkey),
    ],
    content: action === "signup" ? `Signed up for the ${slotLabel(slot)} shift on ${day}` : `Can no longer do the ${slotLabel(slot)} shift on ${day}`,
  };
}

/** kind 0 for the member's bot-derived key, from their Discord profile, with the NIP-39 claim. */
export function buildProfile(member: DiscordMember, now = new Date()): EventTemplate {
  const content: Record<string, string> = { name: member.displayName, display_name: member.displayName, about: `@${member.username} on the Commons Hub Discord` };
  if (member.avatar) content.picture = member.avatar;
  return {
    kind: KIND_PROFILE,
    created_at: nowSeconds(now),
    tags: [["i", `discord:${member.id}`], ["k", "discord"]],
    content: JSON.stringify(content),
  };
}

/** The bot's attestation that `keys` belong to this Discord member. Complete list each time. */
export function buildAttestation(member: DiscordMember, keys: string[], community: Community, botPubkey: string, now = new Date()): EventTemplate {
  const unique = [...new Set(keys.filter((k) => /^[0-9a-f]{64}$/.test(k)))];
  return {
    kind: KIND_ATTESTATION,
    created_at: nowSeconds(now),
    tags: [["d", `discord:${member.id}`], ...unique.map((k) => ["p", k]), ...baseTags(community, botPubkey)],
    content: JSON.stringify({ name: member.displayName }),
  };
}

/** Newest event per (author, d): how addressable kinds are read. */
export function latestAddressable<T extends Event>(events: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const event of events) {
    const key = `${event.pubkey}:${tag(event, "d") ?? ""}`;
    const current = byKey.get(key);
    if (!current || current.created_at < event.created_at) byKey.set(key, event);
  }
  return [...byKey.values()];
}

export interface MemberLink {
  discordId: string;
  name?: string;
  keys: string[];
  roles: string[];
}

/** discord id → keys, from attestations by trusted providers (newest per provider and d, merged). */
export function parseAttestations(events: Event[], providers: string[]): MemberLink[] {
  const trusted = new Set(providers);
  const out = new Map<string, MemberLink>();
  for (const event of latestAddressable(events.filter((e) => e.kind === KIND_ATTESTATION && trusted.has(e.pubkey)))) {
    const d = tag(event, "d");
    if (!d?.startsWith("discord:")) continue;
    const discordId = d.slice("discord:".length);
    let name: string | undefined;
    try {
      name = (JSON.parse(event.content || "{}") as { name?: string }).name;
    } catch { /* no name */ }
    const link = out.get(discordId) ?? { discordId, name, keys: [], roles: [] };
    link.name = link.name ?? name;
    for (const key of tagsOf(event, "p")) if (!link.keys.includes(key)) link.keys.push(key);
    for (const role of tagsOf(event, "role")) if (!link.roles.includes(role)) link.roles.push(role);
    out.set(discordId, link);
  }
  return [...out.values()];
}

export interface ProfileInfo {
  pubkey: string;
  name?: string;
  discordId?: string;
}

export function parseProfiles(events: Event[]): ProfileInfo[] {
  return latestAddressable(events.filter((e) => e.kind === KIND_PROFILE)).map((event) => {
    let content: { name?: string; display_name?: string } = {};
    try {
      content = JSON.parse(event.content || "{}");
    } catch { /* unreadable */ }
    const claim = tagsOf(event, "i").find((i) => i.startsWith("discord:"));
    return { pubkey: event.pubkey, name: content.display_name || content.name, discordId: claim?.slice("discord:".length) };
  });
}

export interface NostrSignup {
  /** Attendee's Discord id, when any trusted attestation, profile claim or on-behalf tag names one. */
  discordId?: string;
  pubkey: string;
  name: string;
  day: string;
  slotCode: string;
  status: "accepted" | "declined";
  /** When the newest RSVP for this attendee and slot was published. */
  at: number;
  /** Who signed the RSVP, when it was a steward acting on behalf of the attendee. */
  signedByDiscordId?: string;
}

/**
 * State of every (attendee, day, slot) the RSVPs describe: the newest RSVP
 * wins whoever signed it (the member from any of their keys, or a steward on
 * their behalf). Same rules as the website's parseSignups, so both agree.
 */
export function parseRsvps(
  rsvps: Event[],
  coordinator: string,
  community: Community,
  days: string[],
  slots: ShiftSlot[],
  links: MemberLink[],
  profiles: ProfileInfo[],
): NostrSignup[] {
  const byCoordinate = new Map<string, { day: string; code: string }>();
  for (const day of days) for (const slot of slots) byCoordinate.set(shiftCoordinate(coordinator, community, day, slot), { day, code: slotCode(slot) });
  const linkByKey = new Map<string, MemberLink>();
  for (const link of links) for (const key of link.keys) linkByKey.set(key, link);
  const linkByDiscord = new Map(links.map((l) => [l.discordId, l]));
  const profileByKey = new Map(profiles.map((p) => [p.pubkey, p]));
  const profileByDiscord = new Map(profiles.filter((p) => p.discordId).map((p) => [p.discordId!, p]));
  const nameOf = (pubkey: string | undefined, discordId: string | undefined, fallback?: string) => {
    const profile = (pubkey && profileByKey.get(pubkey)) || (discordId && profileByDiscord.get(discordId)) || undefined;
    const link = (pubkey && linkByKey.get(pubkey)) || (discordId && linkByDiscord.get(discordId)) || undefined;
    return profile?.name || link?.name || fallback || `${(pubkey ?? "").slice(0, 8)}…`;
  };

  const latest = new Map<string, NostrSignup>();
  for (const event of rsvps.filter((e) => e.kind === KIND_RSVP)) {
    const where = tagsOf(event, "a").map((a) => byCoordinate.get(a)).find(Boolean);
    if (!where) continue;
    const authorLink = linkByKey.get(event.pubkey);
    const authorDiscord = authorLink?.discordId ?? profileByKey.get(event.pubkey)?.discordId;
    const named = tag(event, "discord");
    const onBehalf = !!named && named !== authorDiscord;
    if (onBehalf && event.pubkey !== coordinator && !authorLink?.roles.includes("steward")) continue;
    const attendeeDiscord = named ?? authorDiscord;
    const attendeeKey = onBehalf ? linkByDiscord.get(named!)?.keys[0] : event.pubkey;
    const signup: NostrSignup = {
      discordId: attendeeDiscord,
      pubkey: attendeeKey ?? event.pubkey,
      name: nameOf(attendeeKey, attendeeDiscord, tag(event, "name")),
      day: where.day,
      slotCode: where.code,
      status: (tag(event, "status") ?? "accepted") === "declined" ? "declined" : "accepted",
      at: event.created_at,
      ...(onBehalf ? { signedByDiscordId: authorDiscord } : {}),
    };
    const key = `${attendeeDiscord ?? event.pubkey}:${where.day}:${where.code}`;
    const current = latest.get(key);
    if (!current || current.at < signup.at) latest.set(key, signup);
  }
  return [...latest.values()].sort((a, b) => a.at - b.at);
}

// ── keys ───────────────────────────────────────────────────────────────────

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The member's key: sha256 of the bot secret and the member's Discord id.
 * Deterministic, so nothing is stored; a new bot secret means new member keys
 * (and new attestations, which is fine: attestations merge).
 */
export async function deriveMemberSecretKey(botSecretKey: Uint8Array, guildId: string, discordUserId: string): Promise<Uint8Array> {
  const material = new TextEncoder().encode(`token-bot:shift-member:${guildId}:${discordUserId}:${hex(botSecretKey)}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", material));
}

// ── the client ─────────────────────────────────────────────────────────────

const DRY_RUN = getEnv("DRY_RUN") === "true";

export class ShiftsNostr {
  private static instances = new Map<string, ShiftsNostr>();
  private pool = new SimplePool();
  readonly relays: string[];
  readonly botSecretKey: Uint8Array;
  readonly botPubkey: string;
  private readonly configuredCoordinator?: string;
  private extraProviders: string[];
  private sitePubkey: string = KNOWN_SITE_PUBKEY;
  private siteFetchedAt = 0;
  private ensured = new Set<string>();

  private constructor(readonly community: Community, settings: ShiftsNostrSettings, nsec: string) {
    this.relays = settings.relays?.length ? settings.relays : DEFAULT_RELAYS;
    this.botSecretKey = nip19.decode(nsec).data as Uint8Array;
    this.botPubkey = getPublicKey(this.botSecretKey);
    this.configuredCoordinator = settings.coordinatorNpub ? (nip19.decode(settings.coordinatorNpub).data as string) : undefined;
    this.extraProviders = (settings.identityProviders ?? []).map((n) => (n.startsWith("npub") ? (nip19.decode(n).data as string) : n));
  }

  /** One client per guild; null when Nostr is disabled or no NOSTR_NSEC is set. */
  static forGuild(community: Community, settings: ShiftsNostrSettings = {}): ShiftsNostr | null {
    if (settings.enabled === false) return null;
    const nsec = getEnv("NOSTR_NSEC");
    if (!nsec) return null;
    let instance = ShiftsNostr.instances.get(community.guildId);
    if (!instance) {
      instance = new ShiftsNostr(community, settings, nsec);
      ShiftsNostr.instances.set(community.guildId, instance);
    }
    return instance;
  }

  get npub() {
    return nip19.npubEncode(this.botPubkey);
  }

  /** The coordinator whose occurrences RSVPs point at: this bot unless configured otherwise. */
  get coordinator(): string {
    return this.configuredCoordinator ?? this.botPubkey;
  }

  /** Identity providers whose attestations name members: the bot, the coordinator, the website, plus configured ones. */
  async providers(): Promise<string[]> {
    await this.refreshSitePubkey();
    return [...new Set([this.botPubkey, this.coordinator, this.sitePubkey, ...this.extraProviders])];
  }

  private async refreshSitePubkey() {
    if (Date.now() - this.siteFetchedAt < 60 * 60 * 1000) return;
    this.siteFetchedAt = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(SITE_IDENTITY_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) {
        const data = (await response.json()) as { site?: { pubkey?: string } };
        if (data.site?.pubkey && /^[0-9a-f]{64}$/.test(data.site.pubkey)) this.sitePubkey = data.site.pubkey;
      }
    } catch (error) {
      console.warn("[shifts-nostr] could not fetch the site identity, using the known site key:", (error as Error).message);
    }
  }

  async query(filter: Filter, maxWait = 3000): Promise<Event[]> {
    try {
      const events = await this.pool.querySync(this.relays, filter, { maxWait });
      const seen = new Set<string>();
      return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
    } catch (error) {
      console.error("[shifts-nostr] query failed:", error);
      return [];
    }
  }

  /** Live updates: calls `onEvent` for every event matching the filter, stored ones first. */
  subscribe(filter: Filter, onEvent: (event: Event) => void): () => void {
    const sub = this.pool.subscribeMany(this.relays, [filter], { onevent: onEvent });
    return () => sub.close();
  }

  /** Sign with `secretKey` and publish; resolves when at least one relay accepted. */
  async publish(template: EventTemplate, secretKey: Uint8Array = this.botSecretKey): Promise<Event> {
    const event = finalizeEvent(template, secretKey);
    if (DRY_RUN) {
      console.log(">>> DRY RUN: shifts nostr publish", event.kind, event.tags.find((t) => t[0] === "d")?.[1], event.content);
      return event;
    }
    const results = await Promise.allSettled(this.pool.publish(this.relays, event));
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    if (accepted === 0) {
      const reasons = results.map((r, i) => `${this.relays[i]}: ${r.status === "rejected" ? String(r.reason).slice(0, 120) : "ok"}`).join("; ");
      throw new Error(`No relay accepted the event: ${reasons}`);
    }
    return event;
  }

  async ensureCommunityDefinition(description: string): Promise<void> {
    if (this.coordinator !== this.botPubkey || this.ensured.has("community")) return;
    const existing = await this.query({ kinds: [KIND_COMMUNITY], authors: [this.botPubkey], "#d": [communityD(this.community)] });
    if (existing.length === 0) await this.publish(buildCommunityDefinition(this.community, this.botPubkey, description));
    this.ensured.add("community");
  }

  /** Publish the occurrence for a day and slot if this bot is the coordinator and has not yet. */
  async ensureShiftOccurrence(day: string, slot: ShiftSlot, capacity: number, title: string): Promise<void> {
    if (this.coordinator !== this.botPubkey) return;
    const d = shiftD(this.community, day, slot);
    if (this.ensured.has(d)) return;
    const existing = await this.query({ kinds: [KIND_SHIFT], authors: [this.botPubkey], "#d": [d] });
    if (existing.length === 0) await this.publish(buildShiftOccurrence(this.community, this.botPubkey, day, slot, capacity, title));
    this.ensured.add(d);
  }

  async memberKey(member: { id: string }): Promise<{ secretKey: Uint8Array; pubkey: string }> {
    const secretKey = await deriveMemberSecretKey(this.botSecretKey, this.community.guildId, member.id);
    return { secretKey, pubkey: getPublicKey(secretKey) };
  }

  /**
   * Make sure the member's derived key is attested by the bot and has a
   * profile, so relays accept its writes and other apps can name it.
   */
  async ensureMemberIdentity(member: DiscordMember): Promise<{ secretKey: Uint8Array; pubkey: string }> {
    const key = await this.memberKey(member);
    const marker = `member:${member.id}:${member.displayName}`;
    if (this.ensured.has(marker)) return key;
    const [attestations, profiles] = await Promise.all([
      this.query({ kinds: [KIND_ATTESTATION], authors: [this.botPubkey], "#d": [`discord:${member.id}`] }),
      this.query({ kinds: [KIND_PROFILE], authors: [key.pubkey] }),
    ]);
    const known = parseAttestations(attestations, [this.botPubkey])[0];
    if (!known || !known.keys.includes(key.pubkey) || known.name !== member.displayName) {
      const keys = [...new Set([...(known?.keys ?? []), key.pubkey])];
      await this.publish(buildAttestation(member, keys, this.community, this.botPubkey));
    }
    if (profiles.length === 0) await this.publish(buildProfile(member), key.secretKey);
    this.ensured.add(marker);
    return key;
  }

  /** Sign up or cancel: publish the member's RSVP (and whatever it depends on). */
  async publishRsvp(
    action: "signup" | "cancel",
    member: DiscordMember,
    day: string,
    slot: ShiftSlot,
    options: { capacity: number; title: string; communityDescription: string },
  ): Promise<Event> {
    await this.ensureCommunityDefinition(options.communityDescription);
    await this.ensureShiftOccurrence(day, slot, options.capacity, options.title);
    const key = await this.ensureMemberIdentity(member);
    const event = await this.publish(buildRsvp(action, this.community, this.coordinator, this.botPubkey, day, slot), key.secretKey);
    console.log(`[shifts-nostr] ${action} published for <@${member.username}> ${day} ${slotCode(slot)} (${event.id.slice(0, 8)})`);
    return event;
  }

  /** Current state of every attendee for the given days, from the relays. */
  async loadSignups(days: string[], slots: ShiftSlot[]): Promise<NostrSignup[]> {
    if (days.length === 0) return [];
    const coordinates: string[] = [];
    for (const day of days) for (const slot of slots) coordinates.push(shiftCoordinate(this.coordinator, this.community, day, slot));
    const rsvps: Event[] = [];
    for (let i = 0; i < coordinates.length; i += 100) {
      rsvps.push(...(await this.query({ kinds: [KIND_RSVP], "#a": coordinates.slice(i, i + 100), limit: 1000 })));
    }
    if (rsvps.length === 0) return [];
    const authors = [...new Set(rsvps.map((e) => e.pubkey))];
    const named = [...new Set(rsvps.map((e) => tag(e, "discord")).filter((d): d is string => !!d))];
    const providers = await this.providers();
    const [byKey, byDiscord, profiles] = await Promise.all([
      this.query({ kinds: [KIND_ATTESTATION], authors: providers, "#p": authors, limit: 500 }),
      named.length ? this.query({ kinds: [KIND_ATTESTATION], authors: providers, "#d": named.map((d) => `discord:${d}`), limit: 500 }) : Promise.resolve([] as Event[]),
      this.query({ kinds: [KIND_PROFILE], authors, limit: 500 }),
    ]);
    const attestations = [...byKey, ...byDiscord];
    return parseRsvps(rsvps, this.coordinator, this.community, days, slots, parseAttestations(attestations, providers), parseProfiles(profiles));
  }

  async close() {
    this.pool.close(this.relays);
  }
}
