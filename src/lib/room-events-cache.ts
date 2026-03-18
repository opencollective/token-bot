/**
 * Room Events Cache
 * 
 * Pre-fetches and caches all room calendar events for a rolling 4-week window.
 * All consumers (/shifts, /book, etc.) read from memory — zero API calls at interaction time.
 * 
 * Usage:
 *   import { getRoomEventsCache, invalidateRoomEventsCache, initRoomEventsCache } from "./lib/room-events-cache.ts";
 *   
 *   // On bot startup:
 *   await initRoomEventsCache(calendarIds);
 *   
 *   // On interaction:
 *   const cache = getRoomEventsCache();
 *   const events = cache.getEventsForDate("2026-03-18");
 *   const count = cache.getEventCountForDate("2026-03-18");
 *   
 *   // After creating/deleting a booking:
 *   invalidateRoomEventsCache();
 */

import { GoogleCalendarClient } from "./googlecalendar.ts";

export interface RoomEvent {
  title: string;
  room: string;
  start: string;  // ISO datetime
  end: string;    // ISO datetime
}

// The main data structure: YYYYMMDD -> RoomEvent[]
let eventsMap: Map<string, RoomEvent[]> = new Map();
let calendarIds: string[] = [];
let calendarIdToRoom: Map<string, string> = new Map();
let lastRefresh: number = 0;
let refreshPromise: Promise<void> | null = null;

// Refresh interval: 1 hour (background refresh for staleness)
const BACKGROUND_REFRESH_MS = 60 * 60 * 1000;

/**
 * Format a date to YYYYMMDD key
 */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Parse YYYYMMDD key to Date
 */
export function fromDateKey(key: string): Date {
  const year = parseInt(key.substring(0, 4));
  const month = parseInt(key.substring(4, 6)) - 1;
  const day = parseInt(key.substring(6, 8));
  return new Date(year, month, day);
}

/**
 * Fetch events from multiple calendars for a date range.
 * Returns a map of YYYYMMDD -> RoomEvent[].
 * Exported for direct use and testing.
 */
export async function getEventsForDateRange(
  startDate: Date,
  endDate: Date,
  calIds: string[],
  calIdToRoom?: Map<string, string>,
  calendarClient?: GoogleCalendarClient,
): Promise<Map<string, RoomEvent[]>> {
  const calendar = calendarClient || new GoogleCalendarClient();
  const result = new Map<string, RoomEvent[]>();

  const results = await Promise.allSettled(
    calIds.map((calId) => calendar.listEvents(calId, startDate, endDate))
  );

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    if (res.status !== "fulfilled") {
      console.error(`[room-events-cache] Failed to fetch calendar ${calIds[i]}:`, res.reason);
      continue;
    }

    const roomName = calIdToRoom?.get(calIds[i]) || `calendar-${i}`;

    for (const event of res.value) {
      // Handle both timed (dateTime) and all-day (date) events
      const startStr = event.start.dateTime || (event.start as any).date;
      const endStr = event.end.dateTime || (event.end as any).date;
      if (!startStr) continue;

      const eventDate = new Date(startStr);
      if (isNaN(eventDate.getTime())) continue;

      const dateKey = toDateKey(eventDate);
      const roomEvent: RoomEvent = {
        title: event.summary || "(no title)",
        room: roomName,
        start: startStr,
        end: endStr || startStr,
      };

      const existing = result.get(dateKey) || [];
      existing.push(roomEvent);
      result.set(dateKey, existing);
    }
  }

  return result;
}

/**
 * Initialize the cache with calendar IDs and room name mappings.
 * Call once at bot startup.
 */
export async function initRoomEventsCache(
  calIdToRoom: Map<string, string>,
): Promise<void> {
  calendarIdToRoom = calIdToRoom;
  calendarIds = Array.from(calIdToRoom.keys());
  await refreshCache();
  console.log(`[room-events-cache] Initialized with ${calendarIds.length} calendars, ${eventsMap.size} days cached`);
}

/**
 * Refresh the cache (fetches next 4 weeks + past 30 days).
 */
async function refreshCache(): Promise<void> {
  // Deduplicate concurrent refreshes
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const pastStart = new Date();
      pastStart.setDate(pastStart.getDate() - 30);
      pastStart.setHours(0, 0, 0, 0);

      const futureEnd = new Date();
      futureEnd.setDate(futureEnd.getDate() + 28);
      futureEnd.setHours(23, 59, 59, 999);

      const newMap = await getEventsForDateRange(pastStart, futureEnd, calendarIds, calendarIdToRoom);
      eventsMap = newMap;
      lastRefresh = Date.now();

      const totalEvents = Array.from(newMap.values()).reduce((sum, arr) => sum + arr.length, 0);
      console.log(`[room-events-cache] Refreshed: ${totalEvents} events across ${newMap.size} days`);
    } catch (error) {
      console.error("[room-events-cache] Refresh failed:", error);
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Invalidate the cache — triggers async re-fetch.
 * Returns immediately; the refresh happens in background.
 */
export function invalidateRoomEventsCache(): void {
  console.log("[room-events-cache] Cache invalidated, refreshing...");
  refreshCache();
}

/**
 * Check if cache might be stale and refresh in background if needed.
 */
function ensureFresh(): void {
  if (Date.now() - lastRefresh > BACKGROUND_REFRESH_MS) {
    refreshCache();
  }
}

/**
 * Wait for the cache to be ready (blocks until first refresh completes).
 * Call this before reading if you need guaranteed data.
 */
export async function ensureRoomEventsCacheReady(): Promise<void> {
  if (lastRefresh > 0) return; // Already initialized
  if (refreshPromise) await refreshPromise; // Wait for in-progress refresh
}

/**
 * Get the cache accessor. All reads are from memory — instant.
 */
export function getRoomEventsCache() {
  ensureFresh();

  return {
    /** Get all events for a specific date (YYYYMMDD or Date) */
    getEventsForDate(dateOrKey: string | Date): RoomEvent[] {
      const key = typeof dateOrKey === "string"
        ? (dateOrKey.includes("-") ? dateOrKey.replace(/-/g, "") : dateOrKey)
        : toDateKey(dateOrKey);
      return eventsMap.get(key) || [];
    },

    /** Get event count for a specific date */
    getEventCountForDate(dateOrKey: string | Date): number {
      return this.getEventsForDate(dateOrKey).length;
    },

    /** Get events for a date filtered by time overlap */
    getEventsForSlot(date: Date, startHour: string, endHour: string): RoomEvent[] {
      const events = this.getEventsForDate(date);
      const [sh, sm] = startHour.split(":").map(Number);
      const [eh, em] = endHour.split(":").map(Number);
      const slotStart = new Date(date); slotStart.setHours(sh, sm, 0, 0);
      const slotEnd = new Date(date); slotEnd.setHours(eh, em, 0, 0);

      return events.filter(ev => {
        const evStart = new Date(ev.start);
        const evEnd = new Date(ev.end);
        return evStart < slotEnd && evEnd > slotStart;
      });
    },

    /** Get event counts per date for a range (for dropdowns) */
    getCountsForRange(startDate: Date, days: number): Map<string, number> {
      const counts = new Map<string, number>();
      for (let i = 0; i < days; i++) {
        const d = new Date(startDate);
        d.setDate(startDate.getDate() + i);
        const key = toDateKey(d);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const count = (eventsMap.get(key) || []).length;
        if (count > 0) counts.set(dateStr, count);
      }
      return counts;
    },

    /** Raw access to the full map */
    get raw(): Map<string, RoomEvent[]> {
      return eventsMap;
    },

    /** Cache age in ms */
    get age(): number {
      return Date.now() - lastRefresh;
    },

    /** Whether cache has been initialized */
    get initialized(): boolean {
      return lastRefresh > 0;
    },
  };
}
