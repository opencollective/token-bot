/**
 * Signed door links for guests of a booking, in the format the door server
 * (github.com/commonshub/door, server/index.js verifyEventOrganizerSignature)
 * already accepts for Luma event attendees:
 *
 *   https://door.commonshub.brussels/open?name&host&reason&timestamp&startTime&duration[&eventUrl]&sig
 *
 * sig is an EIP-191 signature of "name=…&host=…&reason=…&timestamp=…&startTime=…&duration=…[&eventUrl=…]&booking=1"
 * (raw values, not URL-encoded) by a key listed in the door's authorized_keys.json; here
 * DOOR_SIGNING_KEY ("token-bot /book guests"). The door opens from 30 min before startTime until
 * 30 min after startTime + duration. booking=1 (signed) makes the door post
 * "🚪 {name} opened the door for {reason} (booked by {host})" in the door channel
 * (commonshub/door server/lib/signed-link.js).
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
  let message = `name=${p.name}&host=${p.host}&reason=${p.reason}&timestamp=${p.timestamp}&startTime=${p.startTime}&duration=${p.duration}`;
  if (p.eventUrl) message += `&eventUrl=${p.eventUrl}`;
  return message + "&booking=1";
}

/** "5-7pm", "9:30am-12pm", "11am-1pm" in Brussels time. */
export function timeRange(start: Date, end: Date, timezone = "Europe/Brussels"): string {
  const parts = (d: Date) => {
    const [h, m] = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).split(":").map(Number);
    const suffix = h >= 12 ? "pm" : "am";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return { label: m ? `${h12}:${String(m).padStart(2, "0")}` : `${h12}`, suffix };
  };
  const a = parts(start), b = parts(end);
  return a.suffix === b.suffix ? `${a.label}-${b.label}${b.suffix}` : `${a.label}${a.suffix}-${b.label}${b.suffix}`;
}

/** The reason shown in #door: "Mush Room booking today from 5-7pm". The link only works that day. */
export function bookingReason(room: string, start: Date, end: Date): string {
  return `${room} booking today from ${timeRange(start, end)}`;
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
    booking: "1",
    sig,
  });
  return `${DOOR_URL}/open?${q.toString()}`;
}
