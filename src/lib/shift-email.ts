/**
 * Confirmation email (with an .ics) for a caretaking shift sign-up made with /shifts.
 */
import { buildIcs, HUB } from "./booking-email.ts";
import { getEnv } from "./utils.ts";

export const HANDBOOK_URL = "https://commonshub.brussels/handbook";
export const SHIFTS_CHANNEL_URL = "https://discord.com/channels/1280532848604086365/1484493597901455370";

export interface ShiftConfirmation {
  memberName: string;
  email?: string;
  start: Date;
  end: Date;
  timezone?: string;
  reward: { amount: number; symbol: string };
  doorLink?: string | null;
  /** Google Calendar event id, so the .ics matches the calendar entry. */
  calendarEventId?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (n: number) => Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));

/** "Tue 7 Oct" in the hub's timezone. */
export function shortDay(d: Date, tz = "Europe/Brussels"): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).replace(/,/g, "");
}

/** "Tuesday 7 October 2026" in the hub's timezone. */
export function longDay(d: Date, tz = "Europe/Brussels"): string {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz }).replace(/,/g, "");
}

/** "17:30" in the hub's timezone. */
export function hhmm(d: Date, tz = "Europe/Brussels"): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
}

export function rewardText(r: { amount: number; symbol: string }): string {
  const unit = r.symbol === "CHT" ? (r.amount === 1 ? "token" : "tokens") : r.symbol;
  return `${num(r.amount)} ${unit}${r.symbol === "CHT" ? ` (${r.symbol})` : ""}`;
}

export function buildShiftEmail(d: ShiftConfirmation): { subject: string; html: string; text: string } {
  const tz = d.timezone || "Europe/Brussels";
  const time = `${hhmm(d.start, tz)}–${hhmm(d.end, tz)}`;
  const subject = `You're on shift: ${shortDay(d.start, tz)}, ${time} at the Commons Hub`;
  const when = `${longDay(d.start, tz)}, ${time}`;
  const where = `${HUB.address} (right in front of Brussels Central Station)`;
  const reward = `${rewardText(d.reward)}, to claim after the shift as usual`;

  const intro = `You signed up for a caretaking shift. Thank you for taking care of the Commons Hub!`;
  const why = [
    `The Commons Hub only exists because members take care of it. Shifts are how we keep this common space open, tidy and welcoming.`,
    `On shift, you're the host: greet people as they arrive, show them around, and make them feel at home. Many people discover the hub during an event, and "we never have the opportunity to make a good first impression twice".`,
    `A great first experience is what turns visitors into a community of users of the space who keep coming back. That community is our primary way of funding the space.`,
  ];
  const practical = `Everything practical (opening and closing, the door, the kitchen, the fridge…) is in the Commons Hub Handbook.`;
  const questions = `Questions? Ask Elinor on Discord, or post in #shifts.`;
  const cantMake = `Can't make it? Cancel with /shifts on Discord.`;

  const doorNotes = [
    `Tap the button when you are at the door: it opens the door for you.`,
    `It works from 30 minutes before your shift until 30 minutes after it.`,
    `The link is personal: please don't share it.`,
  ];

  const button = (href: string, label: string, color = "#001309", border = "#001309") =>
    `<a href="${esc(href)}" style="display:inline-block;background:#ffffff;color:${color};border:2px solid ${border};text-decoration:none;font-weight:600;padding:9px 18px;border-radius:8px">${label}</a>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#FBF4F2;color:#001309;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF4F2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid #eaded9">
<tr><td style="padding:28px 28px 8px" align="left">
  <a href="${HUB.website}"><img src="${HUB.logoUrl}" alt="${HUB.name}" width="120" style="display:block;width:120px;height:auto;border:0"></a>
</td></tr>
<tr><td style="padding:8px 28px 32px">
  <h1 style="font-size:22px;line-height:1.3;margin:12px 0 8px">Hi ${esc(d.memberName)}, you're on shift</h1>
  <p style="margin:0 0 16px">${esc(intro)}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF4F2;border-radius:10px">
    <tr><td style="padding:16px 18px;font-size:15px">
      <div><strong>When:</strong> ${esc(when)}</div>
      <div><strong>Where:</strong> ${esc(where)}</div>
      <div><strong>Reward:</strong> ${esc(reward)}</div>
    </td></tr>
  </table>
  <p style="margin:12px 0 0;font-size:14px;color:#5d625e">The calendar file is attached: open it to add the shift to your calendar.</p>
${d.doorLink ? `
  <h2 style="font-size:17px;margin:28px 0 6px">Getting in</h2>
  <p style="margin:8px 0">${button(d.doorLink, "🚪 Open the door")}</p>
  <ul style="margin:8px 0 0;padding-left:20px;font-size:15px">${doorNotes.map((n) => `<li style="margin-bottom:4px">${esc(n)}</li>`).join("")}</ul>` : ""}

  <h2 style="font-size:17px;margin:28px 0 6px">Why shifts matter</h2>
  ${why.map((p) => `<p style="margin:0 0 8px">${esc(p)}</p>`).join("\n  ")}

  <h2 style="font-size:17px;margin:28px 0 6px">Everything practical</h2>
  <p style="margin:0 0 8px">${esc(practical)}</p>
  <p style="margin:12px 0 0">${button(HANDBOOK_URL, "Commons Hub Handbook", "#b83500", "#FF4C02")}</p>

  <h2 style="font-size:17px;margin:28px 0 6px">Questions, or can't make it?</h2>
  <p style="margin:0 0 8px">Questions? Ask Elinor on Discord, or post in <a href="${SHIFTS_CHANNEL_URL}" style="color:#b83500">#shifts</a>.</p>
  <p style="margin:0 0 8px">${esc(cantMake)}</p>
</td></tr>
<tr><td style="padding:24px 28px 28px;font-size:13px;color:#5d625e;border-top:1px solid #eaded9">
  ${HUB.name} · ${esc(HUB.address)} · <a href="${HUB.website}" style="color:#5d625e">commonshub.brussels</a>
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    `Hi ${d.memberName}, you're on shift`,
    "",
    intro,
    "",
    `When: ${when}`,
    `Where: ${where}`,
    `Reward: ${reward}`,
    "The calendar file is attached.",
    ...(d.doorLink ? ["", "GETTING IN", `Open the door: ${d.doorLink}`, ...doorNotes.map((n) => `- ${n}`)] : []),
    "",
    "WHY SHIFTS MATTER",
    ...why,
    "",
    "EVERYTHING PRACTICAL",
    practical,
    `Handbook: ${HANDBOOK_URL}`,
    "",
    "QUESTIONS, OR CAN'T MAKE IT?",
    questions,
    cantMake,
    "",
    `${HUB.name} · ${HUB.address} · ${HUB.website}`,
  ].join("\n");

  return { subject, html, text };
}

export async function sendShiftConfirmation(d: ShiftConfirmation): Promise<{ id: string }> {
  if (!d.email) throw new Error("no email address");
  const apiKey = getEnv("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  const { subject, html, text } = buildShiftEmail(d);
  const ics = buildIcs([{
    uid: d.calendarEventId ? `${d.calendarEventId}@commonshub.brussels` : `shift-${d.start.getTime()}@commonshub.brussels`,
    start: d.start,
    end: d.end,
    summary: "Caretaking shift (Commons Hub Brussels)",
    description: [
      `Handbook: ${HANDBOOK_URL}`,
      d.doorLink ? `Open the door: ${d.doorLink}` : "",
    ].filter(Boolean).join("\n"),
    location: `${HUB.name}, ${HUB.address}`,
  }]);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: HUB.from,
      to: [d.email],
      reply_to: [HUB.replyTo],
      subject,
      html,
      text,
      attachments: [{
        filename: "commonshub-shift.ics",
        content: btoa(String.fromCharCode(...new TextEncoder().encode(ics))),
        content_type: "text/calendar; charset=utf-8; method=PUBLISH",
      }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { id: (body as { id?: string }).id || "" };
}
