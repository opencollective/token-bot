/**
 * Confirmation email for a room booked on behalf of a guest (/book → "For a guest...").
 *
 * Sent to the guest, cc the member who booked and paid, with an .ics attached.
 * Besides the booking details it explains what CHT is (the booking was paid with
 * tokens earned by stewarding the space), the house rule, an invitation to become
 * a member, and what the place costs to run, with a link to contribute.
 *
 * Sent through Resend (RESEND_API_KEY), from hello@commonshub.brussels, the domain
 * the Commons Hub's Resend account is verified for. Builders are pure for tests.
 */

import { getEnv } from "./utils.ts";

export const HUB = {
  name: "Commons Hub Brussels",
  address: "Rue de la Madeleine 51, 1000 Brussels",
  website: "https://commonshub.brussels",
  membershipUrl: "https://commonshub.brussels/membership",
  contributeUrl: "https://commonshub.brussels/contribute",
  logoUrl: "https://commonshub.brussels/brandkit/commonshub-logo-sticker.png",
  from: "Commons Hub Brussels <hello@commonshub.brussels>",
  replyTo: "hello@commonshub.brussels",
};

export interface CostLine {
  label: string;
  amountEur: number;
  color: string;
}
export interface MonthlyCosts {
  totalEur: number;
  lines: CostLine[];
  source: "live" | "fallback";
}

/** The website's cost palette (src/components/contribute/fixed-costs-chart.tsx, light mode), by slot. */
export const COST_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

/** Figures from commonshub.brussels/contribute on 2026-10-02, used if the live page cannot be read. */
export const FALLBACK_COSTS: MonthlyCosts = {
  totalEur: 9820.23,
  lines: [
    { label: "Rent", amountEur: 6546.76, color: COST_COLORS[0] },
    { label: "Property tax (regional)", amountEur: 1266.27, color: COST_COLORS[1] },
    { label: "Office tax (local)", amountEur: 1076.58, color: COST_COLORS[2] },
    { label: "Furniture rental", amountEur: 637.67, color: COST_COLORS[3] },
    { label: "Electricity (Engie)", amountEur: 238.5, color: COST_COLORS[4] },
    { label: "Internet (Proximus)", amountEur: 54.45, color: COST_COLORS[5] },
  ],
  source: "fallback",
};

/**
 * Read the fixed costs from the contribute page's cost bar: each segment is
 * <a title="Rent: €6,546.76 a month, 67%" style="…background-color:var(--cost-1)" …>.
 */
export function parseCosts(html: string): MonthlyCosts | null {
  const lines: CostLine[] = [];
  for (const tag of html.match(/<a [^>]*title="[^"]*: €[\d,.]+ a month[^"]*"[^>]*>/g) ?? []) {
    const t = tag.match(/title="([^"]+?): €([\d,.]+) a month/);
    if (!t) continue;
    const slot = parseInt(tag.match(/var\(--cost-(\d+)\)/)?.[1] ?? "0");
    const label = t[1].replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'");
    lines.push({ label, amountEur: parseFloat(t[2].replace(/,/g, "")), color: COST_COLORS[slot - 1] ?? "#8a8f8b" });
  }
  if (lines.length === 0 || lines.some((l) => !isFinite(l.amountEur))) return null;
  return { totalEur: lines.reduce((sum, l) => sum + l.amountEur, 0), lines, source: "live" };
}

export async function fetchMonthlyCosts(): Promise<MonthlyCosts> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(HUB.contributeUrl, { signal: controller.signal });
    if (res.ok) return parseCosts(await res.text()) ?? FALLBACK_COSTS;
  } catch { /* fall back */ } finally {
    clearTimeout(timer);
  }
  return FALLBACK_COSTS;
}

export interface RoomRates {
  eurPerHour?: number;
  tokensPerHour?: number;
  tokenSymbol?: string;
}

/** The room's usual rates from its /book prices: a euro token (EURb, EURe…) and the community token (CHT). */
export function ratesFromPrices(prices: { token: string; amount: number }[] | undefined): RoomRates {
  const eur = prices?.find((p) => /^eur/i.test(p.token));
  const tok = prices?.find((p) => !/^eur/i.test(p.token));
  return { eurPerHour: eur?.amount, tokensPerHour: tok?.amount, tokenSymbol: tok?.token };
}

const num = (n: number) => Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));

/** "Usual rate: €35 or 1 CHT per hour", or "" when nothing is known. */
export function rateLine(r?: RoomRates): string {
  if (!r) return "";
  const parts = [
    r.eurPerHour ? `€${num(r.eurPerHour)}` : "",
    r.tokensPerHour ? `${num(r.tokensPerHour)} ${r.tokenSymbol || "CHT"}` : "",
  ].filter(Boolean);
  return parts.length ? `Usual rate: ${parts.join(" or ")} per hour` : "";
}

/** Whole euros, no decimals: €6,547. */
export const eurRounded = (n: number) => "€" + Math.round(n).toLocaleString("en-GB");

/** The website's cost card, as email-safe tables: total, a stacked bar, and a legend with amounts. */
export function costsCardHtml(costs: MonthlyCosts): string {
  const total = costs.totalEur || 1;
  const segments = costs.lines.map((l, i) => {
    const width = Math.max(0.5, (l.amountEur / total) * 100).toFixed(2);
    const gap = i < costs.lines.length - 1 ? "border-right:2px solid #ffffff;" : "";
    return `<td width="${width}%" style="background:${l.color};height:16px;line-height:16px;font-size:0;${gap}">&nbsp;</td>`;
  }).join("");
  const legend = costs.lines.map((l) => `<tr>
        <td width="14" style="padding:5px 10px 5px 0;vertical-align:middle"><div style="width:12px;height:12px;border-radius:3px;background:${l.color}"></div></td>
        <td style="padding:5px 0;font-size:15px;color:#001309">${l.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td>
        <td align="right" style="padding:5px 0;font-size:15px;color:#001309;white-space:nowrap">${eurRounded(l.amountEur)}</td>
      </tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eaded9;border-radius:10px;margin:12px 0 0">
    <tr><td style="padding:18px 20px">
      <div style="font-size:30px;font-weight:700;line-height:1.1;color:#001309">${eurRounded(costs.totalEur)}</div>
      <div style="font-size:14px;color:#5d625e;margin-top:2px">in fixed costs, every month</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border-radius:6px;overflow:hidden;table-layout:fixed"><tr>${segments}</tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px">${legend}</table>
    </td></tr>
  </table>`;
}

// ── room photo ──────────────────────────────────────────────────────────────

/** token-bot product slug → website room slug and its cover image (src/settings/rooms.json heroImage, 2026-10-02). */
export const ROOM_PAGES: Record<string, { slug: string; heroImage: string }> = {
  satoshiroom: { slug: "satoshi", heroImage: "/images/satoshi-room.jpg" },
  phonebooth: { slug: "phonebooth", heroImage: "/images/phonebooth.jpg" },
  mushroom: { slug: "mushroom", heroImage: "/images/mush-room.jpg" },
  angelroom: { slug: "angel", heroImage: "/images/angel-room.jpeg" },
  ostromroom: { slug: "ostrom", heroImage: "/images/img-2144.jpeg" },
  coworking: { slug: "coworking", heroImage: "/images/chb-facade.avif" },
};

/** The website serves room covers through its image proxy as JPEG, which every mail app can show. */
export const proxiedImage = (path: string, size = "md") => `${HUB.website}/api/image-proxy?url=${encodeURIComponent(path)}&size=${size}`;

/** The room's cover image as shown on its page on the website (looked up live, fallback to the known image). */
export async function fetchRoomImage(productSlug: string): Promise<string | undefined> {
  const room = ROOM_PAGES[productSlug];
  if (!room) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${HUB.website}/rooms/${room.slug}`, { signal: controller.signal });
    if (res.ok) {
      const src = (await res.text()).match(/src="(\/api\/image-proxy\?url=([^"&]+)[^"]*)"/);
      if (src) return proxiedImage(decodeURIComponent(src[2]));
    }
  } catch { /* fall back */ } finally {
    clearTimeout(timer);
  }
  return proxiedImage(room.heroImage);
}

// ── ICS ─────────────────────────────────────────────────────────────────────

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** Fold to 75 octets per line as RFC 5545 asks (continuation lines start with a space). */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

export interface IcsEvent {
  uid: string;
  sequence?: number;
  cancelled?: boolean;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location: string;
  url?: string;
}

export function buildIcs(events: IcsEvent[], now = new Date()): string {
  const cancelling = events.length > 0 && events.every((e) => e.cancelled);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Commons Hub Brussels//token-bot booking//EN",
    "CALSCALE:GREGORIAN",
    cancelling ? "METHOD:CANCEL" : "METHOD:PUBLISH",
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `SEQUENCE:${e.sequence ?? 0}`,
      ...(e.cancelled ? ["STATUS:CANCELLED"] : []),
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(e.start)}`,
      `DTEND:${icsDate(e.end)}`,
      `SUMMARY:${icsText(e.summary)}`,
      `DESCRIPTION:${icsText(e.description)}`,
      `LOCATION:${icsText(e.location)}`,
      ...(e.url ? [`URL:${e.url}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ── the email ───────────────────────────────────────────────────────────────

export interface BookingEmailDetails {
  guestName: string;
  guestEmail: string;
  bookerName: string;
  bookerEmail?: string;
  eventName: string;
  roomName: string;
  occurrences: { start: Date; end: Date }[];
  priceTotal: number;
  tokenSymbol: string;
  eventUrl?: string;
  txUrl?: string;
  bookingId: string;
  timezone?: string;
  /** What happened: a new booking (default), a change, or a cancellation. */
  kind?: "confirmed" | "updated" | "cancelled";
  /** The room's cover image (fetchRoomImage). */
  roomImageUrl?: string;
  /** The room's usual hourly rates, shown under the photo (ratesFromPrices). */
  rates?: RoomRates;
  /** Calendar identity per occurrence (same order), so updates and cancellations replace the guest's entry. */
  uids?: string[];
  sequence?: number;
  /** For a change: what it was before. */
  previous?: { roomName: string; occurrences: { start: Date; end: Date }[] };
  /** Signed door link per occurrence (same order), when DOOR_SIGNING_KEY is set. */
  doorLinks?: (string | null)[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function whenLine(o: { start: Date; end: Date }, tz: string): string {
  const day = o.start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz });
  const t = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  return `${day}, ${t(o.start)}–${t(o.end)}`;
}

export function buildBookingEmail(d: BookingEmailDetails, costs: MonthlyCosts): { subject: string; html: string; text: string } {
  const tz = d.timezone || "Europe/Brussels";
  const dates = d.occurrences.map((o) => whenLine(o, tz));
  const firstDay = d.occurrences[0].start.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });
  const kind = d.kind ?? "confirmed";
  const subjectPrefix = { confirmed: "Your booking at the Commons Hub", updated: "Your booking at the Commons Hub was changed", cancelled: "Your booking at the Commons Hub was cancelled" }[kind];
  const subject = `${subjectPrefix}: ${d.roomName}, ${firstDay}${d.occurrences.length > 1 ? ` (+${d.occurrences.length - 1} more)` : ""}`;
  const heading = { confirmed: "your room is booked", updated: "your booking was changed", cancelled: "your booking was cancelled" }[kind];
  const previousLine = d.previous ? `Before: ${d.previous.roomName}, ${d.previous.occurrences.map((o) => whenLine(o, tz)).join("; ")}.` : "";
  const contact = d.bookerEmail
    ? `If you have any question about this booking, please contact ${d.bookerName} (${d.bookerEmail}), who booked it for you and is in cc of this email: just reply to this email.`
    : `If you have any question about this booking, please contact ${d.bookerName}, who booked it for you.`;
  const price = `${Number(d.priceTotal.toFixed(2))} ${d.tokenSymbol}`;

  const paragraphs = {
    intro: {
      confirmed: `${d.bookerName} booked the ${d.roomName} at the ${HUB.name} for you.`,
      updated: `${d.bookerName} changed the booking they made for you at the ${HUB.name}. Here are the new details.`,
      cancelled: `${d.bookerName} cancelled the booking they made for you at the ${HUB.name}. The room is no longer reserved for you at this time.`,
    }[kind],
    cht: `This booking was paid with ${price}. CHT, the Commons Hub Token, is how our community keeps track of time given to the place: members earn it by stewarding the space (doing shifts, cleaning, keeping the plants alive, welcoming people, running the newsletter…) and can spend it on rooms like this one. So this room is yours for this time because ${d.bookerName} gave time to the community.`,
    house: `The Commons Hub is a community space, not a rental venue. We ask everyone to treat it as if it were their own house. Unless you are messy at home, in which case please take care of it as if it were somebody else's house 🙂 Leave the room as you found it, put the chairs and tables back, and take your trash with you.`,
    member: `If you like the place, become a member: members can call this place home, book rooms, and steward it together with us.`,
    costs: `Keeping the doors open costs about ${eurRounded(costs.totalEur)} a month in fixed costs. It is all paid by the community, through memberships, room bookings and contributions. If this space is useful to you, you can help sustain it.`,
  };

  const doors = (d.doorLinks ?? []).map((url, i) => ({ url, o: d.occurrences[i] })).filter((x): x is { url: string; o: { start: Date; end: Date } } => !!x.url && !!x.o);
  const shortDay = (o: { start: Date }) => o.start.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz });
  const t = (x: Date) => x.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  const early = (o: { start: Date }) => t(new Date(o.start.getTime() - 30 * 60000));
  const late = (o: { end: Date }) => t(new Date(o.end.getTime() + 30 * 60000));
  const doorNotes = [
    `Tap the button when you are at the door: it opens the door for you.`,
    `It works from 30 minutes before your booking until 30 minutes after it${doors.length === 1 ? ` (${early(doors[0].o)}–${late(doors[0].o)})` : ""}.`,
    `The link is personal: please don't share it. Everyone in the community sees in our #door channel that you opened the door.`,
    `Please close the door behind you. If it doesn't work, ring the bell or contact ${d.bookerName}.`,
  ];
  const doorHtml = doors.length === 0 ? "" : `
  <h2 style="font-size:17px;margin:28px 0 6px">Getting in</h2>
  ${doors.map(({ url, o }) => `<p style="margin:8px 0"><a href="${esc(url)}" style="display:inline-block;background:#ffffff;color:#001309;border:2px solid #001309;text-decoration:none;font-weight:600;padding:9px 18px;border-radius:8px">🚪 Open the door${doors.length > 1 ? ` · ${esc(shortDay(o))}` : ""}</a></p>`).join("")}
  <ul style="margin:8px 0 0;padding-left:20px;font-size:15px">${doorNotes.map((n) => `<li style="margin-bottom:4px">${esc(n)}</li>`).join("")}</ul>`;
  const doorText = doors.length === 0 ? [] : [
    "",
    "GETTING IN",
    ...doors.map(({ url, o }) => `Open the door${doors.length > 1 ? ` (${shortDay(o)})` : ""}: ${url}`),
    ...doorNotes.map((n) => `- ${n}`),
  ];

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#FBF4F2;color:#001309;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF4F2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid #eaded9">
<tr><td style="padding:28px 28px 8px" align="left">
  <a href="${HUB.website}"><img src="${HUB.logoUrl}" alt="${HUB.name}" width="120" style="display:block;width:120px;height:auto;border:0"></a>
</td></tr>
<tr><td style="padding:8px 28px 32px">
  <h1 style="font-size:22px;line-height:1.3;margin:12px 0 8px">Hi ${esc(d.guestName)}, ${heading}</h1>
  <p style="margin:0 0 16px">${esc(paragraphs.intro)}</p>
  ${d.roomImageUrl && kind !== "cancelled" ? `<img src="${esc(d.roomImageUrl)}" alt="${esc(d.roomName)}" width="544" style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:10px;margin:0 0 ${rateLine(d.rates) ? "6px" : "16px"}">` : ""}
  ${rateLine(d.rates) && kind !== "cancelled" ? `<p style="margin:0 0 16px;font-size:14px;color:#5d625e">${esc(d.roomName)} · ${esc(rateLine(d.rates))}</p>` : ""}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF4F2;border-radius:10px">
    <tr><td style="padding:16px 18px;font-size:15px">
      <div style="margin-bottom:6px"><strong>${esc(d.eventName)}</strong></div>
      <div><strong>Room:</strong> ${esc(d.roomName)}</div>
      <div><strong>When:</strong> ${dates.map(esc).join("<br>")}</div>
      <div><strong>Where:</strong> ${esc(HUB.address)} (right in front of Brussels Central Station)</div>
      <div><strong>Booked by:</strong> ${esc(d.bookerName)}${d.bookerEmail ? ` (${esc(d.bookerEmail)}, in cc)` : ""}</div>
      ${d.eventUrl ? `<div><strong>Event page:</strong> <a href="${esc(d.eventUrl)}" style="color:#b83500">${esc(d.eventUrl)}</a></div>` : ""}
      ${previousLine ? `<div style="margin-top:6px;color:#5d625e">${esc(previousLine)}</div>` : ""}
    </td></tr>
  </table>
  <p style="margin:12px 0 0;font-size:14px;color:#5d625e">${kind === "cancelled" ? "The attached calendar file removes the booking from your calendar." : kind === "updated" ? "The attached calendar file updates the booking in your calendar." : "The calendar file is attached: open it to add the booking to your calendar."}</p>
  <p style="margin:12px 0 0">${esc(contact)}</p>
${kind === "cancelled" ? "" : doorHtml}
${kind === "cancelled" ? `<!-- cancelled: no further sections -->` : `
  <h2 style="font-size:17px;margin:28px 0 6px">Paid with time, not money</h2>
  <p style="margin:0 0 8px">${esc(paragraphs.cht)}</p>
  ${d.txUrl ? `<p style="margin:0;font-size:14px"><a href="${esc(d.txUrl)}" style="color:#b83500">See the transaction</a></p>` : ""}

  <h2 style="font-size:17px;margin:28px 0 6px">A community space</h2>
  <p style="margin:0 0 8px">${esc(paragraphs.house)}</p>
  <p style="margin:0 0 8px">${esc(paragraphs.member)}</p>
  <p style="margin:12px 0 0"><a href="${HUB.membershipUrl}" style="display:inline-block;background:#ffffff;color:#b83500;border:2px solid #FF4C02;text-decoration:none;font-weight:600;padding:9px 18px;border-radius:8px">Become a member</a></p>

  <h2 style="font-size:17px;margin:28px 0 6px">What it costs to keep the hub open</h2>
  <p style="margin:0 0 8px">${esc(paragraphs.costs)}</p>
  ${costsCardHtml(costs)}
  <p style="margin:16px 0 0"><a href="${HUB.contributeUrl}" style="display:inline-block;background:#ffffff;color:#b83500;border:2px solid #FF4C02;text-decoration:none;font-weight:600;padding:9px 18px;border-radius:8px">Contribute</a></p>`}
</td></tr>
<tr><td style="padding:24px 28px 28px;font-size:13px;color:#5d625e;border-top:1px solid #eaded9">
  ${HUB.name} · ${esc(HUB.address)} · <a href="${HUB.website}" style="color:#5d625e">commonshub.brussels</a><br>
  Questions about this booking? Contact ${esc(d.bookerName)}${d.bookerEmail ? ` (${esc(d.bookerEmail)}), in cc: reply to this email` : ""}.
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    `Hi ${d.guestName}, ${heading}`,
    "",
    paragraphs.intro,
    "",
    d.eventName,
    `Room: ${d.roomName}${rateLine(d.rates) && kind !== "cancelled" ? ` (${rateLine(d.rates).replace(/^Usual rate: /, "usual rate ")})` : ""}`,
    `When: ${dates.join("; ")}`,
    `Where: ${HUB.address} (right in front of Brussels Central Station)`,
    `Booked by: ${d.bookerName}${d.bookerEmail ? ` (${d.bookerEmail}, in cc)` : ""}`,
    ...(d.eventUrl ? [`Event page: ${d.eventUrl}`] : []),
    ...(previousLine ? [previousLine] : []),
    kind === "cancelled" ? "The attached calendar file removes the booking from your calendar." : "The calendar file is attached.",
    "",
    contact,
    ...(kind === "cancelled" ? [] : [...doorText,
    "",
    "PAID WITH TIME, NOT MONEY",
    paragraphs.cht,
    ...(d.txUrl ? [`Transaction: ${d.txUrl}`] : []),
    "",
    "A COMMUNITY SPACE",
    paragraphs.house,
    paragraphs.member,
    `Become a member: ${HUB.membershipUrl}`,
    "",
    "WHAT IT COSTS TO KEEP THE HUB OPEN",
    paragraphs.costs,
    ...costs.lines.map((l) => `- ${l.label}: ${eurRounded(l.amountEur)}`),
    `Contribute: ${HUB.contributeUrl}`]),
    "",
    `${HUB.name} · ${HUB.address} · ${HUB.website}`,
  ].join("\n");

  return { subject, html, text };
}

/** Build and send a confirmation, change or cancellation email. Throws on failure; callers decide what to tell the booker. */
export async function sendBookingConfirmation(d: BookingEmailDetails): Promise<{ id: string }> {
  const apiKey = getEnv("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  const costs = await fetchMonthlyCosts();
  const { subject, html, text } = buildBookingEmail(d, costs);
  const cancelled = d.kind === "cancelled";
  const ics = buildIcs(d.occurrences.map((o, i) => ({
    uid: d.uids?.[i] ?? `${d.bookingId}-${i}@commonshub.brussels`,
    sequence: d.sequence ?? 0,
    cancelled,
    start: o.start,
    end: o.end,
    summary: `${d.eventName} (${d.roomName}, Commons Hub Brussels)`,
    description: `${d.roomName} booked by ${d.bookerName} for ${d.guestName}.${d.eventUrl ? `\n${d.eventUrl}` : ""}\n${HUB.website}`,
    location: `${d.roomName}, ${HUB.name}, ${HUB.address}`,
    url: d.eventUrl,
  })));
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: HUB.from,
      to: [d.guestEmail],
      ...(d.bookerEmail && d.bookerEmail.toLowerCase() !== d.guestEmail.toLowerCase() ? { cc: [d.bookerEmail] } : {}),
      reply_to: d.bookerEmail ? [d.bookerEmail] : [HUB.replyTo],
      subject,
      html,
      text,
      attachments: [{
        filename: "commonshub-booking.ics",
        content: btoa(String.fromCharCode(...new TextEncoder().encode(ics))),
        content_type: `text/calendar; charset=utf-8; method=${cancelled ? "CANCEL" : "PUBLISH"}`,
      }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { id: (body as { id?: string }).id || "" };
}
