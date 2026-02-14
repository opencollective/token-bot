/**
 * Google Calendar API client for managing calendars and events
 */

import { google } from "googleapis";

export type GoogleCalendarConfig = {
  keyFilePath?: string;
};

export type CalendarListItem = {
  kind: string;
  etag: string;
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  colorId?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  selected?: boolean;
  accessRole?: string;
  defaultReminders?: Array<{ method: string; minutes: number }>;
  primary?: boolean;
};

export type CalendarEvent = {
  id?: string;
  summary: string;
  description?: string;
  start: {
    dateTime: string;
    timeZone?: string;
  };
  end: {
    dateTime: string;
    timeZone?: string;
  };
  attendees?: Array<{ email: string }>;
  reminders?: {
    useDefault: boolean;
  };
};

export type ConflictError = {
  message: string;
  conflictingEvent: CalendarEvent;
};

/**
 * Client for interacting with Google Calendar API
 */
export class GoogleCalendarClient {
  private auth: any;
  private calendar: any;

  constructor(config?: GoogleCalendarConfig) {
    const keyFilePath = config?.keyFilePath ||
      Deno.env.get("GOOGLE_ACCOUNT_KEY_FILEPATH") ||
      "./google-account-key.json";

    this.auth = new google.auth.GoogleAuth({
      keyFile: keyFilePath,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });

    this.calendar = google.calendar({ version: "v3", auth: this.auth });
  }

  /**
   * List all calendars shared with the service account
   * @returns Array of calendar list items
   */
  async listCalendars(): Promise<CalendarListItem[]> {
    try {
      const response = await this.calendar.calendarList.list();

      // Debug logging
      if (Deno.env.get("DEBUG")) {
        console.log("DEBUG - Raw API response status:", response.status);
        console.log("DEBUG - Raw API response data:", JSON.stringify(response.data, null, 2));
      }

      return response.data.items || [];
    } catch (error) {
      throw new Error(`Failed to list calendars: ${error}`);
    }
  }

  /**
   * Add a shared calendar to the service account's calendar list
   * This is necessary for shared calendars to appear in listCalendars()
   * @param calendarId - The ID of the calendar to add
   * @returns The added calendar list item
   */
  async addCalendarToList(calendarId: string): Promise<CalendarListItem> {
    try {
      const response = await this.calendar.calendarList.insert({
        requestBody: {
          id: calendarId,
        },
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to add calendar to list: ${error}`);
    }
  }

  /**
   * Get information about a specific calendar by ID
   * Works even if the calendar is not in the calendar list
   * @param calendarId - The ID of the calendar
   * @returns Calendar metadata
   */
  async getCalendar(calendarId: string): Promise<any> {
    try {
      const response = await this.calendar.calendars.get({
        calendarId,
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get calendar: ${error}`);
    }
  }

  /**
   * Check if a calendar is in the service account's calendar list
   * @param calendarId - The ID of the calendar to check
   * @returns true if calendar is in the list, false otherwise
   */
  async isCalendarInList(calendarId: string): Promise<boolean> {
    try {
      const calendars = await this.listCalendars();
      return calendars.some((cal) => cal.id === calendarId);
    } catch (error) {
      return false;
    }
  }

  /**
   * Ensure a calendar is in the list (add it if not already there)
   * This is useful for working with shared calendars
   * @param calendarId - The ID of the calendar
   * @returns The calendar list item (existing or newly added)
   */
  async ensureCalendarInList(calendarId: string): Promise<CalendarListItem> {
    try {
      // First check if it's already in the list
      const calendars = await this.listCalendars();
      const existing = calendars.find((cal) => cal.id === calendarId);

      if (existing) {
        return existing;
      }

      // Not in list, try to add it
      return await this.addCalendarToList(calendarId);
    } catch (error) {
      throw new Error(`Failed to ensure calendar in list: ${error}`);
    }
  }

  /**
   * Create a new calendar
   * @param summary - The name/title of the calendar
   * @param description - Optional description for the calendar
   * @param timeZone - Optional timezone (defaults to UTC)
   * @returns The created calendar
   */
  async createCalendar(
    summary: string,
    description?: string,
    timeZone: string = "UTC",
  ): Promise<CalendarListItem> {
    try {
      const response = await this.calendar.calendars.insert({
        requestBody: {
          summary,
          description,
          timeZone,
        },
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create calendar: ${error}`);
    }
  }

  /**
   * List events in a calendar within a date range
   * @param calendarId - The ID of the calendar
   * @param startDate - Start date for the range
   * @param endDate - End date for the range
   * @returns Array of calendar events
   */
  async listEvents(
    calendarId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<CalendarEvent[]> {
    try {
      const response = await this.calendar.events.list({
        calendarId,
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });
      return response.data.items || [];
    } catch (error) {
      throw new Error(`Failed to list events: ${error}`);
    }
  }

  /**
   * Check if there are any conflicting events in the given time range
   * @param calendarId - The ID of the calendar
   * @param startTime - Start time for the event
   * @param endTime - End time for the event
   * @param excludeEventId - Optional event ID to exclude from conflict check (for updates)
   * @returns The conflicting event if found, null otherwise
   */
  private async checkForConflicts(
    calendarId: string,
    startTime: Date,
    endTime: Date,
    excludeEventId?: string,
  ): Promise<CalendarEvent | null> {
    const events = await this.listEvents(calendarId, startTime, endTime);

    for (const event of events) {
      // Skip the event being updated
      if (excludeEventId && event.id === excludeEventId) {
        continue;
      }

      const eventStart = new Date(event.start.dateTime);
      const eventEnd = new Date(event.end.dateTime);

      // Check if events overlap
      // Events overlap if: startTime < eventEnd AND endTime > eventStart
      if (startTime < eventEnd && endTime > eventStart) {
        return event;
      }
    }

    return null;
  }

  /**
   * Create an event in a calendar
   * @param calendarId - The ID of the calendar
   * @param event - The event details
   * @returns The created event
   * @throws ConflictError if there's a conflicting event
   */
  async createEvent(
    calendarId: string,
    event: CalendarEvent,
  ): Promise<CalendarEvent> {
    const startTime = new Date(event.start.dateTime);
    const endTime = new Date(event.end.dateTime);

    // Check for conflicts
    const conflictingEvent = await this.checkForConflicts(
      calendarId,
      startTime,
      endTime,
    );

    if (conflictingEvent) {
      const error = new Error(
        `Event conflicts with existing event: "${conflictingEvent.summary}" ` +
          `(${conflictingEvent.start.dateTime} - ${conflictingEvent.end.dateTime})`,
      ) as Error & { conflictingEvent: CalendarEvent };
      error.conflictingEvent = conflictingEvent;
      throw error;
    }

    try {
      const response = await this.calendar.events.insert({
        calendarId,
        requestBody: event,
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create event: ${error}`);
    }
  }

  /**
   * Delete an event from a calendar
   * @param calendarId - The ID of the calendar
   * @param eventId - The ID of the event to delete
   */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.calendar.events.delete({
        calendarId,
        eventId,
      });
    } catch (error) {
      throw new Error(`Failed to delete event: ${error}`);
    }
  }

  /**
   * Test write access to a calendar by creating and immediately deleting a test event
   * @param calendarId - The ID of the calendar to test
   * @returns true if write access is available, false otherwise
   */
  async testWriteAccess(calendarId: string): Promise<boolean> {
    try {
      // Create a test event far in the future
      const testStart = new Date();
      testStart.setFullYear(testStart.getFullYear() + 10);
      const testEnd = new Date(testStart.getTime() + 60000);

      const response = await this.calendar.events.insert({
        calendarId,
        requestBody: {
          summary: "[TEST] Write access check - safe to delete",
          start: { dateTime: testStart.toISOString() },
          end: { dateTime: testEnd.toISOString() },
        },
      });

      // Immediately delete the test event
      if (response.data.id) {
        await this.calendar.events.delete({
          calendarId,
          eventId: response.data.id,
        });
      }

      return true;
    } catch (error) {
      return false;
    }
  }
}
