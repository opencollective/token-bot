/**
 * Send calendar invites via email using Resend API + .ics attachment.
 * No Google Domain-Wide Delegation needed.
 */

import { getEnv } from "./utils.ts";

interface CalendarInviteParams {
  to: string;
  summary: string;
  description?: string;
  location?: string;
  startDate: Date;
  endDate: Date;
  timezone: string;
  organizerEmail?: string;
  organizerName?: string;
}

/**
 * Generate an .ics calendar file content
 */
function generateICS(params: CalendarInviteParams): string {
  const formatICSDate = (date: Date): string => {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  };

  const uid = `${Date.now()}-${Math.random().toString(36).substring(2)}@commonshub`;
  const now = formatICSDate(new Date());
  const start = formatICSDate(params.startDate);
  const end = formatICSDate(params.endDate);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Commons Hub Brussels//Token Bot//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART;TZID=${params.timezone}:${start}`,
    `DTEND;TZID=${params.timezone}:${end}`,
    `SUMMARY:${escapeICS(params.summary)}`,
  ];

  if (params.description) {
    lines.push(`DESCRIPTION:${escapeICS(params.description)}`);
  }
  if (params.location) {
    lines.push(`LOCATION:${escapeICS(params.location)}`);
  }
  if (params.organizerEmail) {
    const cn = params.organizerName ? `;CN=${params.organizerName}` : "";
    lines.push(`ORGANIZER${cn}:mailto:${params.organizerEmail}`);
  }
  lines.push(`ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${params.to}`);
  lines.push("STATUS:CONFIRMED");
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  return lines.join("\r\n");
}

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Send a calendar invite email via Resend API.
 * Requires RESEND_API_KEY env var.
 */
export async function sendCalendarInvite(params: CalendarInviteParams): Promise<void> {
  const apiKey = getEnv("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("[calendar-invite] RESEND_API_KEY not set — skipping invite email");
    return;
  }

  const fromEmail = getEnv("CALENDAR_INVITE_FROM") || "shifts@commonshub.brussels";
  const icsContent = generateICS(params);
  const icsBase64 = btoa(icsContent);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [params.to],
      subject: `Calendar Invite: ${params.summary}`,
      html: `<p>You've signed up for a shift at Commons Hub Brussels.</p>
<p><strong>${params.summary}</strong></p>
<p>Please find the calendar invite attached. Add it to your calendar to get a reminder.</p>
<p>Thank you for helping take care of our space! 🙏</p>`,
      attachments: [
        {
          filename: "invite.ics",
          content: icsBase64,
          content_type: "text/calendar; method=REQUEST",
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API error (${response.status}): ${body}`);
  }

  console.log(`[calendar-invite] Sent invite to ${params.to} for "${params.summary}"`);
}
