/**
 * Polls the shifts calendar hourly to detect declined attendees
 * and updates event descriptions with audit trail entries.
 */

import { GoogleCalendarClient, CalendarEvent } from "./googlecalendar.ts";
import { getUserEmail, getUserEmailByEmail } from "./user-emails.ts";

function formatAuditTimestamp(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function appendToDescription(desc: string, line: string): string {
  const trimmed = desc.trimEnd();
  return trimmed ? `${trimmed}\n${line}` : line;
}

let pollerInterval: ReturnType<typeof setInterval> | null = null;

export function startShiftsDeclinePoller(calendarId: string, guildId: string) {
  if (pollerInterval) return;
  
  console.log("[shifts-poller] Starting decline poller (1h interval)");
  
  // Run immediately, then hourly
  checkDeclines(calendarId, guildId).catch(err => 
    console.error("[shifts-poller] Error:", err)
  );
  
  pollerInterval = setInterval(() => {
    checkDeclines(calendarId, guildId).catch(err => 
      console.error("[shifts-poller] Error:", err)
    );
  }, 60 * 60 * 1000);
}

export function stopShiftsDeclinePoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}

async function checkDeclines(calendarId: string, guildId: string) {
  const calendar = new GoogleCalendarClient();
  
  // Check events from today to 30 days ahead
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + 30);
  
  let events: CalendarEvent[];
  try {
    events = await calendar.listEvents(calendarId, start, end);
  } catch (err) {
    console.error("[shifts-poller] Failed to list events:", err);
    return;
  }
  
  for (const event of events) {
    if (!event.attendees || !event.description) continue;
    
    const declinedAttendees = event.attendees.filter(
      (a: any) => a.responseStatus === 'declined'
    );
    
    if (declinedAttendees.length === 0) continue;
    
    let desc = event.description;
    let updated = false;
    
    for (const attendee of declinedAttendees) {
      const email = attendee.email;
      
      // Check if this decline is already recorded
      if (desc.includes(`${email} declined`) || desc.includes(`declined (via calendar)`)) {
        // Check more specifically — look for this email's decline
        const alreadyRecorded = desc.split('\n').some(line => 
          line.includes('declined') && line.includes(email)
        );
        if (alreadyRecorded) continue;
      }
      
      // Try to find the username from the event description signups
      let displayName = email;
      const userInfo = getUserEmailByEmail(guildId, email);
      if (userInfo) {
        // Find username from signup lines in description
        const signupMatch = desc.match(new RegExp(`@(\\S+) signed up \\(discord:${userInfo.discordUserId}\\)`));
        displayName = signupMatch ? `@${signupMatch[1]}` : `discord:${userInfo.discordUserId}`;
      }
      
      desc = appendToDescription(desc, `${formatAuditTimestamp()}: ${displayName} declined (via calendar)`);
      updated = true;
      
      console.log(`[shifts-poller] Recorded decline: ${displayName} on event ${event.summary}`);
    }
    
    if (updated) {
      try {
        await calendar.updateEvent(calendarId, event.id!, { description: desc });
      } catch (err) {
        console.error(`[shifts-poller] Failed to update event ${event.id}:`, err);
      }
    }
  }
}
