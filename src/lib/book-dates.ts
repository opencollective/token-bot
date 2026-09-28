/**
 * Pure helpers for booking a room on several dates at once (/book → "Enter date(s)…").
 *
 * The member types one date, or several separated by commas; the same start
 * time and duration apply to every date. No I/O here so it can be tested.
 */

export const MAX_BOOKING_DATES = 12;

export interface Occurrence {
  start: Date;
  end: Date;
}

export interface CalendarEventLike {
  start: { dateTime?: string | null };
  end: { dateTime?: string | null };
  summary?: string | null;
}

/**
 * Parse "15/03/2026" or "15/03/2026, 22/03/2026, 29/03" (commas, semicolons or
 * new lines between dates; `/`, `-` or `.` inside a date). A date without a
 * year is the next such day from `today`. Returns the valid dates sorted and
 * deduplicated, plus one error line per entry that could not be used.
 */
export function parseDateList(input: string, today: Date): { dates: Date[]; errors: string[] } {
  const errors: string[] = [];
  const byDay = new Map<number, Date>();
  const entries = input.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);

  for (const entry of entries) {
    const match = entry.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2}|\d{4}))?$/);
    if (!match) {
      errors.push(`"${entry}" is not a date (use DD/MM/YYYY)`);
      continue;
    }
    const day = parseInt(match[1]);
    const month = parseInt(match[2]);
    let year = match[3] ? parseInt(match[3]) : today.getFullYear();
    if (match[3] && match[3].length === 2) year += 2000;

    let date = new Date(year, month - 1, day);
    if (month < 1 || month > 12 || date.getDate() !== day || date.getMonth() !== month - 1) {
      errors.push(`"${entry}" does not exist`);
      continue;
    }
    if (!match[3] && date < today) date = new Date(year + 1, month - 1, day);
    if (date < today) {
      errors.push(`"${entry}" is in the past`);
      continue;
    }
    byDay.set(date.getTime(), date);
  }

  const dates = [...byDay.values()].sort((a, b) => a.getTime() - b.getTime());
  if (dates.length > MAX_BOOKING_DATES) {
    errors.push(`at most ${MAX_BOOKING_DATES} dates per booking (got ${dates.length})`);
    return { dates: dates.slice(0, MAX_BOOKING_DATES), errors };
  }
  return { dates, errors };
}

/** The same start time and duration on every date. */
export function occurrencesFor(dates: Date[], hour: number, minute: number, durationMinutes: number): Occurrence[] {
  return dates.map((date) => {
    const start = new Date(date);
    start.setHours(hour, minute, 0, 0);
    return { start, end: new Date(start.getTime() + durationMinutes * 60000) };
  });
}

/** The first event that overlaps the occurrence, if any. */
export function findConflict<T extends CalendarEventLike>(occurrence: Occurrence, events: T[]): T | undefined {
  return events.find((event) => {
    if (!event.start?.dateTime || !event.end?.dateTime) return false;
    const start = new Date(event.start.dateTime);
    const end = new Date(event.end.dateTime);
    return start < occurrence.end && end > occurrence.start;
  });
}
