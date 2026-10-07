/**
 * Pending requests: actions proposed on someone's behalf (by Elinor, through MCP) that only run
 * when the right Discord user clicks Confirm. Stored per guild in DATA_DIR/<guildId>/pending-requests.json
 * so they survive a restart; requests expire after REQUEST_TTL_MS.
 */
import { getEnv } from "./utils.ts";

export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** Decided requests are kept this long, so get_request_status keeps answering. */
const KEEP_DECIDED_MS = 14 * 24 * 60 * 60 * 1000;
const FILE = "pending-requests.json";

export type RequestKind = "mint" | "shift_signup" | "room_booking";

/**
 * pending: waiting for a click · confirmed: executed · cancelled: the user said no ·
 * expired: nobody answered in time · failed: confirmed but execution failed ·
 * handed_off: confirmed, then continued in the interactive /book flow (payment step).
 */
export type RequestStatus = "pending" | "confirmed" | "cancelled" | "expired" | "failed" | "handed_off";

export type MintParams = {
  tokenSymbol: string;
  recipientIds: string[];
  amount: number;
  description?: string;
};

export type ShiftSignupParams = {
  start: string; // ISO
  end: string; // ISO
  calendarEventId?: string;
  email?: string;
};

export type RoomBookingParams = {
  room: string; // product slug
  roomName: string;
  start: string; // ISO
  end: string; // ISO
  title: string;
  guestName?: string;
  guestEmail?: string;
};

export type PendingRequest = {
  id: string;
  kind: RequestKind;
  guildId: string;
  /** Who asked, as given by the caller (e.g. "elinor on behalf of <@123>"). Informational. */
  requestedBy: string;
  /**
   * approval "confirmer": the only Discord user whose click runs it.
   * approval "any_minter": the requester (for limits and display); any member allowed to mint the token can confirm.
   */
  confirmerId: string;
  /** Who can confirm: one person (default), or anyone allowed to mint the token (mint requests only). */
  approval?: "confirmer" | "any_minter";
  /** The Discord user who asked for it (requested by). They can always cancel. */
  requesterId?: string;
  params: MintParams | ShiftSignupParams | RoomBookingParams;
  summary: string;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** When approval is "any_minter": who is pinged as approvers (a role, or up to 5 people). */
  approvers?: { roleId?: string; userIds?: string[] };
  /** Where the Confirm/Cancel message was posted. */
  message?: { channelId: string; messageId: string; dm: boolean; url: string };
  result?: unknown;
  error?: string;
};

const dataDir = () => getEnv("DATA_DIR") || "/data";
const path = (guildId: string) => `${dataDir()}/${guildId}/${FILE}`;

const cache = new Map<string, Map<string, PendingRequest>>();

async function load(guildId: string): Promise<Map<string, PendingRequest>> {
  const cached = cache.get(guildId);
  if (cached) return cached;
  const map = new Map<string, PendingRequest>();
  try {
    const list = JSON.parse(await Deno.readTextFile(path(guildId))) as PendingRequest[];
    for (const r of list) map.set(r.id, r);
  } catch {
    // no file yet
  }
  cache.set(guildId, map);
  return map;
}

async function save(guildId: string): Promise<void> {
  const map = cache.get(guildId);
  if (!map) return;
  const now = Date.now();
  // Drop old decided requests so the file stays small.
  for (const [id, r] of map) {
    if (r.status !== "pending" && now - new Date(r.decidedAt ?? r.expiresAt).getTime() > KEEP_DECIDED_MS) map.delete(id);
  }
  await Deno.mkdir(`${dataDir()}/${guildId}`, { recursive: true });
  await Deno.writeTextFile(path(guildId), JSON.stringify([...map.values()], null, 2));
}

// Serialise writes per guild.
const locks = new Map<string, Promise<unknown>>();
function locked<T>(guildId: string, fn: (map: Map<string, PendingRequest>) => T | Promise<T>): Promise<T> {
  const next = (locks.get(guildId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const map = await load(guildId);
    const result = await fn(map);
    await save(guildId);
    return result;
  });
  locks.set(guildId, next);
  return next;
}

/** Short, unambiguous, URL-safe id: "req_" + 12 base32 chars. */
export function newRequestId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "req_" + [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export function createRequest(
  r: Omit<PendingRequest, "id" | "status" | "createdAt" | "expiresAt">,
  now = new Date(),
): Promise<PendingRequest> {
  const request: PendingRequest = {
    ...r,
    id: newRequestId(),
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
  };
  return locked(r.guildId, (map) => {
    map.set(request.id, request);
    return request;
  });
}

/** Find a request by id in any guild we know about (loads guild files on demand). */
export async function getRequest(id: string, guildIds: string[] = []): Promise<PendingRequest | undefined> {
  for (const guildId of new Set([...cache.keys(), ...guildIds])) {
    const r = (await load(guildId)).get(id);
    if (r) return r;
  }
  return undefined;
}

export function updateRequest(
  guildId: string,
  id: string,
  fn: (r: PendingRequest) => void,
): Promise<PendingRequest | undefined> {
  return locked(guildId, (map) => {
    const r = map.get(id);
    if (r) fn(r);
    return r;
  });
}

/**
 * Atomically move a pending request to a new status. Returns the request when this call made the
 * transition, or undefined when it was no longer pending (double click, already expired…).
 */
export function transition(
  guildId: string,
  id: string,
  to: RequestStatus,
  by?: string,
  now = new Date(),
): Promise<PendingRequest | undefined> {
  return locked(guildId, (map) => {
    const r = map.get(id);
    if (!r || r.status !== "pending") return undefined;
    if (to !== "expired" && now.getTime() > new Date(r.expiresAt).getTime()) {
      r.status = "expired";
      r.decidedAt = now.toISOString();
      return undefined;
    }
    r.status = to;
    r.decidedAt = now.toISOString();
    if (by) r.decidedBy = by;
    return r;
  });
}

export async function countPendingFor(guildId: string, confirmerId: string): Promise<number> {
  const map = await load(guildId);
  return [...map.values()].filter((r) => r.status === "pending" && r.confirmerId === confirmerId).length;
}

/** Pending requests past their expiry, across the given guilds. */
export async function findExpired(guildIds: string[], now = new Date()): Promise<PendingRequest[]> {
  const out: PendingRequest[] = [];
  for (const guildId of guildIds) {
    for (const r of (await load(guildId)).values()) {
      if (r.status === "pending" && new Date(r.expiresAt).getTime() <= now.getTime()) out.push(r);
    }
  }
  return out;
}

/** What get_request_status returns. */
export function publicStatus(r: PendingRequest) {
  return {
    requestId: r.id,
    kind: r.kind,
    status: r.status,
    summary: r.summary,
    confirmerId: r.confirmerId,
    approval: r.approval ?? "confirmer",
    requesterId: r.requesterId ?? null,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    decidedAt: r.decidedAt ?? null,
    decidedBy: r.decidedBy ?? null,
    confirmedBy: ["confirmed", "failed", "handed_off"].includes(r.status) ? r.decidedBy ?? null : null,
    cancelledBy: r.status === "cancelled" ? r.decidedBy ?? null : null,
    messageUrl: r.message?.url ?? null,
    deliveredBy: r.message ? (r.message.dm ? "dm" : "channel") : null,
    result: r.result ?? null,
    error: r.error ?? null,
  };
}

/** For tests: forget the in-memory cache. */
export function _resetCache() {
  cache.clear();
  locks.clear();
}
