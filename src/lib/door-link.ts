/**
 * Signed door links for guests of a booking, in the format the door server
 * (github.com/commonshub/door, server/index.js verifyEventOrganizerSignature)
 * already accepts for Luma event attendees:
 *
 *   https://door.commonshub.brussels/open?name&host&reason&timestamp&startTime&duration[&eventUrl]&sig
 *
 * sig is an EIP-191 signature of "name=…&host=…&reason=…&timestamp=…&startTime=…&duration=…[&eventUrl=…]"
 * (raw values, not URL-encoded) by a key listed in the door's authorized_keys.json; here
 * DOOR_SIGNING_KEY ("token-bot /book guests"). The door opens from 30 min before startTime until
 * 30 min after startTime + duration, and posts "🚪 {name} opened the door for {reason} hosted by
 * {host}" in the door channel.
 */

import { Wallet } from "ethers";
import { getEnv } from "./utils.ts";

export const DOOR_URL = "https://door.commonshub.brussels";

export interface DoorLinkParams {
  name: string;
  host: string;
  reason: string;
  start: Date;
  end: Date;
  eventUrl?: string;
}

/** The exact string the door server verifies. */
export function doorMessage(p: { name: string; host: string; reason: string; timestamp: number; startTime: number; duration: number; eventUrl?: string }): string {
  const base = `name=${p.name}&host=${p.host}&reason=${p.reason}&timestamp=${p.timestamp}&startTime=${p.startTime}&duration=${p.duration}`;
  return p.eventUrl ? `${base}&eventUrl=${p.eventUrl}` : base;
}

/** Keep values free of characters that would make the signed string ambiguous. */
const clean = (s: string) => s.replace(/[&=\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);

export async function buildDoorLink(p: DoorLinkParams, privateKey = getEnv("DOOR_SIGNING_KEY"), now = new Date()): Promise<string | null> {
  if (!privateKey) return null;
  const fields = {
    name: clean(p.name),
    host: clean(p.host),
    reason: clean(p.reason),
    timestamp: Math.floor(now.getTime() / 1000),
    startTime: Math.floor(p.start.getTime() / 1000),
    duration: Math.max(1, Math.round((p.end.getTime() - p.start.getTime()) / 60000)),
    eventUrl: p.eventUrl && /^https?:\/\/[^\s&]+$/.test(p.eventUrl) ? p.eventUrl : undefined,
  };
  const sig = await new Wallet(privateKey).signMessage(doorMessage(fields));
  const q = new URLSearchParams({
    name: fields.name,
    host: fields.host,
    reason: fields.reason,
    timestamp: String(fields.timestamp),
    startTime: String(fields.startTime),
    duration: String(fields.duration),
    ...(fields.eventUrl ? { eventUrl: fields.eventUrl } : {}),
    sig,
  });
  return `${DOOR_URL}/open?${q.toString()}`;
}
