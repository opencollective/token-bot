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
  share: number; // percent of the monthly total
}
export interface MonthlyCosts {
  totalEur: number;
  lines: CostLine[];
  source: "live" | "fallback";
}

/** Figures from commonshub.brussels/contribute on 2026-10-02, used if the live page cannot be read. */
export const FALLBACK_COSTS: MonthlyCosts = {
  totalEur: 9820.23,
  lines: [
    { label: "Rent", share: 67 },
    { label: "Property tax (regional)", share: 13 },
    { label: "Office tax (local)", share: 11 },
    { label: "Furniture rental", share: 6 },
    { label: "Electricity (Engie)", share: 2 },
    { label: "Internet (Proximus)", share: 0.6 },
  ],
  source: "fallback",
};

/** Parse the fixed-costs summary the contribute page exposes for screen readers. */
export function parseCostsLabel(html: string): MonthlyCosts | null {
  const m = html.match(/aria-label="Fixed costs, €([\d,.]+) a month: ([^"]+)"/);
  if (!m) return null;
  const totalEur = parseFloat(m[1].replace(/,/g, ""));
  const lines = m[2].split(/,\s*(?=[A-Z])/).map((part) => {
    const lm = part.trim().match(/^(.*\S)\s+([\d.]+)%$/);
    return lm ? { label: lm[1], share: parseFloat(lm[2]) } : null;
  }).filter((l): l is CostLine => !!l);
  if (!isFinite(totalEur) || lines.length === 0) return null;
  return { totalEur, lines, source: "live" };
}

export async function fetchMonthlyCosts(): Promise<MonthlyCosts> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(HUB.contributeUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return parseCostsLabel(await res.text()) ?? FALLBACK_COSTS;
  } catch { /* fall back */ }
  return FALLBACK_COSTS;
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
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location: string;
  url?: string;
}

export function buildIcs(events: IcsEvent[], now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Commons Hub Brussels//token-bot booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
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
  /** Signed door link per occurrence (same order), when DOOR_SIGNING_KEY is set. */
  doorLinks?: (string | null)[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const eur = (n: number) => "€" + n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function whenLine(o: { start: Date; end: Date }, tz: string): string {
  const day = o.start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz });
  const t = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  return `${day}, ${t(o.start)}–${t(o.end)}`;
}

export function buildBookingEmail(d: BookingEmailDetails, costs: MonthlyCosts): { subject: string; html: string; text: string } {
  const tz = d.timezone || "Europe/Brussels";
  const dates = d.occurrences.map((o) => whenLine(o, tz));
  const firstDay = d.occurrences[0].start.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });
  const subject = `Your booking at the Commons Hub: ${d.roomName}, ${firstDay}${d.occurrences.length > 1 ? ` (+${d.occurrences.length - 1} more)` : ""}`;
  const price = `${Number(d.priceTotal.toFixed(2))} ${d.tokenSymbol}`;
  const costLines = costs.lines.map((l) => `${l.label} (${l.share}%)`).join(", ");

  const paragraphs = {
    intro: `${d.bookerName} booked the ${d.roomName} at the ${HUB.name} for you.`,
    cht: `This booking was paid with ${price}. CHT, the Commons Hub Token, is how our community keeps track of time given to the place: members earn it by stewarding the space (hosting shifts, cleaning, keeping the plants alive, welcoming people, running the newsletter…) and can spend it on rooms like this one. So this room is yours for this time because ${d.bookerName} gave time to the community.`,
    house: `The Commons Hub is a community space, not a rental venue. We ask everyone to treat it as if it were their own house. Unless you are messy at home, in which case please take care of it as if it were somebody else's house 🙂 Leave the room as you found it, put the chairs and tables back, and take your trash with you.`,
    member: `If you like the place, become a member: members can call this place home, book rooms, and steward it together with us.`,
    costs: `Keeping the doors open costs about ${eur(costs.totalEur)} a month in fixed costs: ${costLines}. It is all paid by the community, through memberships, room bookings and contributions. If this space is useful to you, you can help sustain it.`,
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
  ${doors.map(({ url, o }) => `<p style="margin:8px 0"><a href="${esc(url)}" style="display:inline-block;background:#001309;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">🚪 Open the door${doors.length > 1 ? ` · ${esc(shortDay(o))}` : ""}</a></p>`).join("")}
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
<tr><td style="padding:8px 28px 0">
  <h1 style="font-size:22px;line-height:1.3;margin:12px 0 8px">Hi ${esc(d.guestName)}, your room is booked</h1>
  <p style="margin:0 0 16px">${esc(paragraphs.intro)}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF4F2;border-radius:10px">
    <tr><td style="padding:16px 18px;font-size:15px">
      <div style="margin-bottom:6px"><strong>${esc(d.eventName)}</strong></div>
      <div><strong>Room:</strong> ${esc(d.roomName)}</div>
      <div><strong>When:</strong> ${dates.map(esc).join("<br>")}</div>
      <div><strong>Where:</strong> ${esc(HUB.address)} (right in front of Brussels Central Station)</div>
      <div><strong>Booked by:</strong> ${esc(d.bookerName)}${d.bookerEmail ? ` (${esc(d.bookerEmail)}, in cc)` : ""}</div>
      ${d.eventUrl ? `<div><strong>Event page:</strong> <a href="${esc(d.eventUrl)}" style="color:#b83500">${esc(d.eventUrl)}</a></div>` : ""}
    </td></tr>
  </table>
  <p style="margin:12px 0 0;font-size:14px;color:#5d625e">The calendar file is attached: open it to add the booking to your calendar.</p>
${doorHtml}

  <h2 style="font-size:17px;margin:28px 0 6px">Paid with time, not money</h2>
  <p style="margin:0 0 8px">${esc(paragraphs.cht)}</p>
  ${d.txUrl ? `<p style="margin:0;font-size:14px"><a href="${esc(d.txUrl)}" style="color:#b83500">See the transaction</a></p>` : ""}

  <h2 style="font-size:17px;margin:28px 0 6px">A community space</h2>
  <p style="margin:0 0 8px">${esc(paragraphs.house)}</p>
  <p style="margin:0 0 8px">${esc(paragraphs.member)}</p>
  <p style="margin:12px 0 0"><a href="${HUB.membershipUrl}" style="display:inline-block;background:#FF4C02;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Become a member</a></p>

  <h2 style="font-size:17px;margin:28px 0 6px">What it costs to keep the hub open</h2>
  <p style="margin:0 0 8px">${esc(paragraphs.costs)}</p>
  <p style="margin:12px 0 0"><a href="${HUB.contributeUrl}" style="color:#b83500;font-weight:600">Contribute on commonshub.brussels/contribute</a></p>
</td></tr>
<tr><td style="padding:28px;font-size:13px;color:#5d625e;border-top:1px solid #eaded9;margin-top:24px">
  ${HUB.name} · ${esc(HUB.address)} · <a href="${HUB.website}" style="color:#5d625e">commonshub.brussels</a><br>
  Questions about this booking? Reply to this email or ask ${esc(d.bookerName)}.
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    `Hi ${d.guestName}, your room is booked`,
    "",
    paragraphs.intro,
    "",
    d.eventName,
    `Room: ${d.roomName}`,
    `When: ${dates.join("; ")}`,
    `Where: ${HUB.address} (right in front of Brussels Central Station)`,
    `Booked by: ${d.bookerName}${d.bookerEmail ? ` (${d.bookerEmail}, in cc)` : ""}`,
    ...(d.eventUrl ? [`Event page: ${d.eventUrl}`] : []),
    "The calendar file is attached.",
    ...doorText,
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
    `Contribute: ${HUB.contributeUrl}`,
    "",
    `${HUB.name} · ${HUB.address} · ${HUB.website}`,
  ].join("\n");

  return { subject, html, text };
}

/** Build and send the confirmation. Throws on failure; callers decide what to tell the booker. */
export async function sendBookingConfirmation(d: BookingEmailDetails): Promise<{ id: string }> {
  const apiKey = getEnv("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  const costs = await fetchMonthlyCosts();
  const { subject, html, text } = buildBookingEmail(d, costs);
  const ics = buildIcs(d.occurrences.map((o, i) => ({
    uid: `${d.bookingId}-${i}@commonshub.brussels`,
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
      reply_to: d.bookerEmail ? [d.bookerEmail, HUB.replyTo] : [HUB.replyTo],
      subject,
      html,
      text,
      attachments: [{
        filename: "commonshub-booking.ics",
        content: btoa(String.fromCharCode(...new TextEncoder().encode(ics))),
        content_type: "text/calendar; charset=utf-8; method=PUBLISH",
      }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { id: (body as { id?: string }).id || "" };
}
