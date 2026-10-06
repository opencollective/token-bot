/**
 * Signed cancel links for shift sign-ups.
 *
 * The token is `<payload>.<signature>`, both base64url:
 *   payload   = JSON { e: calendarEventId, u: discordUserId, x: expiry (unix seconds, the shift's end) }
 *   signature = HMAC-SHA256(payload, SHIFT_CANCEL_SECRET, or API_KEY when that isn't set)
 *
 * Whoever holds the link can cancel that one person's sign-up for that one shift until it ends.
 * That's the point: someone at the community tablet may pick the wrong name, and the person who
 * gets the DM must be able to undo it without logging in.
 */
import { getEnv } from "./utils.ts";

export const CANCEL_URL_BASE = "https://commonshub.brussels/shifts/cancel";

export type CancelClaims = { calendarEventId: string; discordUserId: string; exp: number };

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function secret(explicit?: string): string {
  const s = explicit ?? getEnv("SHIFT_CANCEL_SECRET") ?? getEnv("API_KEY");
  if (!s) throw new Error("SHIFT_CANCEL_SECRET (or API_KEY) is not set");
  return s;
}

async function hmac(data: string, key: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signCancelToken(claims: CancelClaims, key?: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ e: claims.calendarEventId, u: claims.discordUserId, x: claims.exp })));
  return `${payload}.${b64url(await hmac(payload, secret(key)))}`;
}

export type VerifyResult =
  | { ok: true; claims: CancelClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export async function verifyCancelToken(token: string, now = new Date(), key?: string): Promise<VerifyResult> {
  const [payload, sig, extra] = String(token || "").split(".");
  if (!payload || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  let given: Uint8Array;
  try {
    given = fromB64url(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!timingSafeEqual(given, await hmac(payload, secret(key)))) return { ok: false, reason: "bad_signature" };
  let raw: { e?: unknown; u?: unknown; x?: unknown };
  try {
    raw = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof raw.e !== "string" || typeof raw.u !== "string" || typeof raw.x !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (now.getTime() / 1000 > raw.x) return { ok: false, reason: "expired" };
  return { ok: true, claims: { calendarEventId: raw.e, discordUserId: raw.u, exp: raw.x } };
}

export async function buildCancelUrl(claims: CancelClaims, key?: string): Promise<string> {
  const base = getEnv("SHIFT_CANCEL_URL_BASE") || CANCEL_URL_BASE;
  return `${base}?t=${encodeURIComponent(await signCancelToken(claims, key))}`;
}
