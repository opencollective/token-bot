/**
 * The email a guest gets when a member buys them a guest pass with a guest email
 * (/guestpass, propose_guest_pass): who invited them, when, where, what it costs, the door
 * button and how to use it, the house rule, an invitation to become a member, and plain-language
 * fine print (PASS_DISCLAIMER). Xavier asked for no token terms paragraph in this guest-facing email. Modelled on the email
 * for a room booked on behalf of someone (booking-email.ts), with the same look.
 *
 * Sent through Resend (RESEND_API_KEY) from hello@commonshub.brussels, cc the member when
 * we know their email, who is also the reply-to. The builder is pure for tests.
 */
import { HUB } from "./booking-email.ts";
import { PASS_DISCLAIMER } from "./guest-pass.ts";
import { getEnv } from "./utils.ts";

export interface GuestPassEmail {
  guestName?: string;
  guestEmail: string;
  hostName: string;
  hostEmail?: string;
  start: Date;
  end: Date;
  doorLink: string;
  /** The pass page on the website (same pass, with the door button). */
  passUrl?: string;
  length: "half-day" | "day";
  /** "Half day: 1 token (a coworking day is €25 + VAT)" (passCost). */
  cost?: string;
  timezone?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildGuestPassEmail(d: GuestPassEmail): { subject: string; html: string; text: string } {
  const tz = d.timezone || "Europe/Brussels";
  const day = d.start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
  const t = (x: Date) => x.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  const when = `${day}, ${t(d.start)}–${t(d.end)}`;
  const hello = d.guestName ? `Hi ${d.guestName}` : "Hi";
  const subject = `${d.hostName} invited you to the Commons Hub: ${day}`;
  const contact = d.hostEmail
    ? `Questions? Ask ${d.hostName} (${d.hostEmail}), who invited you and is in cc: just reply to this email.`
    : `Questions? Ask ${d.hostName}, who invited you.`;
  const paragraphs = {
    intro: `${d.hostName} invited you to the ${HUB.name} and gave you a ${d.length === "day" ? "day" : "half day"} pass: the link below opens the front door for you.`,
    paid: `${d.hostName} paid for your pass with tokens, which members earn by giving time to the community (shifts, cleaning, welcoming people…).`,
    house: `The Commons Hub is a community space, not a rental venue. We ask everyone to treat it as if it were their own house. Unless you are messy at home, in which case please take care of it as if it were somebody else's house 🙂`,
    member: `If you like the place, become a member: members can call this place home, book rooms, and steward it together with us.`,
  };
  const doorNotes = [
    `Tap the button when you are at the door (${HUB.address}, right in front of Brussels Central Station): it opens the door for you.`,
    `It works ${when}, and only then.`,
    `The link is personal: please don't share it. Everyone in the community sees in our #door channel that you opened the door.`,
    `Please close the door behind you. If it doesn't work, ring the bell or contact ${d.hostName}.`,
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
  <h1 style="font-size:22px;line-height:1.3;margin:12px 0 8px">${esc(hello)}, you're invited to the Commons Hub</h1>
  <p style="margin:0 0 16px">${esc(paragraphs.intro)}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF4F2;border-radius:10px">
    <tr><td style="padding:16px 18px;font-size:15px">
      <div><strong>When:</strong> ${esc(when)}</div>
      <div><strong>Where:</strong> ${esc(HUB.address)} (right in front of Brussels Central Station)</div>
      <div><strong>Invited by:</strong> ${esc(d.hostName)}${d.hostEmail ? ` (${esc(d.hostEmail)}, in cc)` : ""}</div>
      ${d.cost ? `<div><strong>Cost:</strong> ${esc(d.cost)}, paid by ${esc(d.hostName)}</div>` : ""}
    </td></tr>
  </table>

  <h2 style="font-size:17px;margin:28px 0 6px">Getting in</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 8px"><tr><td align="center">
    <a href="${esc(d.doorLink)}" style="display:inline-block;background:#001309;color:#ffffff;text-decoration:none;font-weight:700;font-size:18px;padding:14px 30px;border-radius:10px">🚪 Open the door</a>
  </td></tr></table>
  ${d.passUrl ? `<p style="margin:0 0 8px;text-align:center;font-size:14px"><a href="${esc(d.passUrl)}" style="color:#b83500">Open your pass in the browser</a></p>` : ""}
  <ul style="margin:8px 0 0;padding-left:20px;font-size:15px">${doorNotes.map((n) => `<li style="margin-bottom:4px">${esc(n)}</li>`).join("")}</ul>

  <h2 style="font-size:17px;margin:28px 0 6px">Paid with time, not money</h2>
  <p style="margin:0 0 8px">${esc(paragraphs.paid)}</p>

  <h2 style="font-size:17px;margin:28px 0 6px">A community space</h2>
  <p style="margin:0 0 8px">${esc(paragraphs.house)}</p>
  <p style="margin:0 0 8px">${esc(paragraphs.member)}</p>
  <p style="margin:12px 0 0"><a href="${HUB.membershipUrl}" style="display:inline-block;background:#ffffff;color:#b83500;border:2px solid #FF4C02;text-decoration:none;font-weight:600;padding:9px 18px;border-radius:8px">Become a member</a></p>
  <p style="margin:24px 0 0">${esc(contact)}</p>
</td></tr>
<tr><td style="padding:24px 28px 28px;font-size:13px;color:#5d625e;border-top:1px solid #eaded9">
  <p style="margin:0 0 10px;font-size:12px;line-height:1.5">${esc(PASS_DISCLAIMER)}</p>
  ${HUB.name} · ${esc(HUB.address)} · <a href="${HUB.website}" style="color:#5d625e">commonshub.brussels</a>
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    `${hello}, you're invited to the Commons Hub`,
    "",
    paragraphs.intro,
    "",
    `When: ${when}`,
    `Where: ${HUB.address} (right in front of Brussels Central Station)`,
    `Invited by: ${d.hostName}${d.hostEmail ? ` (${d.hostEmail}, in cc)` : ""}`,
    ...(d.cost ? [`Cost: ${d.cost}, paid by ${d.hostName}`] : []),
    "",
    "GETTING IN",
    `Open the door: ${d.doorLink}`,
    ...(d.passUrl ? [`Your pass: ${d.passUrl}`] : []),
    ...doorNotes.map((n) => `- ${n}`),
    "",
    "PAID WITH TIME, NOT MONEY",
    paragraphs.paid,
    "",
    "A COMMUNITY SPACE",
    paragraphs.house,
    paragraphs.member,
    `Become a member: ${HUB.membershipUrl}`,
    "",
    contact,
    "",
    PASS_DISCLAIMER,
    `${HUB.name} · ${HUB.address} · ${HUB.website}`,
  ].join("\n");
  return { subject, html, text };
}

/** Send it. Throws on failure; the caller tells the member. */
export async function sendGuestPassEmail(d: GuestPassEmail): Promise<{ id: string }> {
  const apiKey = getEnv("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  const { subject, html, text } = buildGuestPassEmail(d);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: HUB.from,
      to: [d.guestEmail],
      ...(d.hostEmail && d.hostEmail.toLowerCase() !== d.guestEmail.toLowerCase() ? { cc: [d.hostEmail] } : {}),
      reply_to: d.hostEmail ? [d.hostEmail] : [HUB.replyTo],
      subject,
      html,
      text,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { id: (body as { id?: string }).id || "" };
}
