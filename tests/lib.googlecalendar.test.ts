import { expect } from "@std/expect/expect";
import { stub } from "@std/testing/mock";
import {
  GoogleCalendarClient,
  type CalendarEvent,
  type CalendarListItem,
} from "../src/lib/googlecalendar.ts";

// Mock data
const mockCalendarListItem: CalendarListItem = {
  kind: "calendar#calendarListEntry",
  etag: '"1234567890"',
  id: "test@example.com",
  summary: "Test Calendar",
  description: "A test calendar",
  timeZone: "America/New_York",
  colorId: "1",
  backgroundColor: "#9fe1e7",
  foregroundColor: "#000000",
  selected: true,
  accessRole: "owner",
  defaultReminders: [],
  primary: false,
};

const createMockEvent = (
  id: string,
  summary: string,
  startDateTime: string,
  endDateTime: string,
): CalendarEvent => ({
  id,
  summary,
  description: `Test event: ${summary}`,
  start: {
    dateTime: startDateTime,
    timeZone: "UTC",
  },
  end: {
    dateTime: endDateTime,
    timeZone: "UTC",
  },
  reminders: {
    useDefault: true,
  },
});

Deno.test("GoogleCalendarClient - listCalendars returns calendars", async () => {
  const mockCalendars = [
    mockCalendarListItem,
    {
      ...mockCalendarListItem,
      id: "test2@example.com",
      summary: "Test Calendar 2",
    },
  ];

  // Create a mock client
  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  // Stub the calendar list method
  const listStub = stub(
    client["calendar"].calendarList,
    "list",
    () => Promise.resolve({ data: { items: mockCalendars } }),
  );

  try {
    const calendars = await client.listCalendars();

    expect(calendars).toHaveLength(2);
    expect(calendars[0].summary).toBe("Test Calendar");
    expect(calendars[1].summary).toBe("Test Calendar 2");
  } finally {
    listStub.restore();
  }
});

Deno.test("GoogleCalendarClient - listCalendars handles empty list", async () => {
  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const listStub = stub(
    client["calendar"].calendarList,
    "list",
    () => Promise.resolve({ data: { items: [] } }),
  );

  try {
    const calendars = await client.listCalendars();
    expect(calendars).toHaveLength(0);
  } finally {
    listStub.restore();
  }
});

Deno.test("GoogleCalendarClient - createCalendar creates new calendar", async () => {
  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const insertStub = stub(
    client["calendar"].calendars,
    "insert",
    (params: any) =>
      Promise.resolve({
        data: {
          ...mockCalendarListItem,
          summary: params.requestBody.summary,
          description: params.requestBody.description,
          timeZone: params.requestBody.timeZone,
        },
      }),
  );

  try {
    const calendar = await client.createCalendar(
      "New Test Calendar",
      "A newly created calendar",
      "America/Los_Angeles",
    );

    expect(calendar.summary).toBe("New Test Calendar");
    expect(calendar.description).toBe("A newly created calendar");
    expect(calendar.timeZone).toBe("America/Los_Angeles");
  } finally {
    insertStub.restore();
  }
});

Deno.test("GoogleCalendarClient - createCalendar with defaults", async () => {
  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const insertStub = stub(
    client["calendar"].calendars,
    "insert",
    (params: any) =>
      Promise.resolve({
        data: {
          ...mockCalendarListItem,
          summary: params.requestBody.summary,
          timeZone: params.requestBody.timeZone,
        },
      }),
  );

  try {
    const calendar = await client.createCalendar("Simple Calendar");

    expect(calendar.summary).toBe("Simple Calendar");
    expect(calendar.timeZone).toBe("UTC");
  } finally {
    insertStub.restore();
  }
});

Deno.test("GoogleCalendarClient - listEvents returns events in date range", async () => {
  const startDate = new Date("2024-12-01T00:00:00Z");
  const endDate = new Date("2024-12-31T23:59:59Z");

  const mockEvents = [
    createMockEvent(
      "event1",
      "Team Meeting",
      "2024-12-15T10:00:00Z",
      "2024-12-15T11:00:00Z",
    ),
    createMockEvent(
      "event2",
      "Project Review",
      "2024-12-20T14:00:00Z",
      "2024-12-20T15:30:00Z",
    ),
  ];

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const listStub = stub(
    client["calendar"].events,
    "list",
    (params: any) => {
      expect(params.calendarId).toBe("test@example.com");
      expect(params.timeMin).toBe(startDate.toISOString());
      expect(params.timeMax).toBe(endDate.toISOString());
      return Promise.resolve({ data: { items: mockEvents } });
    },
  );

  try {
    const events = await client.listEvents(
      "test@example.com",
      startDate,
      endDate,
    );

    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe("Team Meeting");
    expect(events[1].summary).toBe("Project Review");
  } finally {
    listStub.restore();
  }
});

Deno.test("GoogleCalendarClient - listEvents handles empty result", async () => {
  const startDate = new Date("2024-12-01T00:00:00Z");
  const endDate = new Date("2024-12-31T23:59:59Z");

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const listStub = stub(
    client["calendar"].events,
    "list",
    () => Promise.resolve({ data: { items: [] } }),
  );

  try {
    const events = await client.listEvents(
      "test@example.com",
      startDate,
      endDate,
    );

    expect(events).toHaveLength(0);
  } finally {
    listStub.restore();
  }
});

Deno.test("GoogleCalendarClient - createEvent creates event successfully", async () => {
  const newEvent = createMockEvent(
    "",
    "New Event",
    "2024-12-25T10:00:00Z",
    "2024-12-25T11:00:00Z",
  );

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  // Stub list to return no conflicting events
  const listStub = stub(
    client["calendar"].events,
    "list",
    () => Promise.resolve({ data: { items: [] } }),
  );

  // Stub insert to simulate event creation
  const insertStub = stub(
    client["calendar"].events,
    "insert",
    (params: any) =>
      Promise.resolve({
        data: {
          ...params.requestBody,
          id: "created-event-id",
        },
      }),
  );

  try {
    const createdEvent = await client.createEvent("test@example.com", newEvent);

    expect(createdEvent.id).toBe("created-event-id");
    expect(createdEvent.summary).toBe("New Event");
  } finally {
    listStub.restore();
    insertStub.restore();
  }
});

Deno.test("GoogleCalendarClient - createEvent detects conflicts", async () => {
  const newEvent = createMockEvent(
    "",
    "Conflicting Event",
    "2024-12-25T10:30:00Z",
    "2024-12-25T11:30:00Z",
  );

  const existingEvent = createMockEvent(
    "existing-event-id",
    "Existing Event",
    "2024-12-25T10:00:00Z",
    "2024-12-25T11:00:00Z",
  );

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  // Stub list to return a conflicting event
  const listStub = stub(
    client["calendar"].events,
    "list",
    () => Promise.resolve({ data: { items: [existingEvent] } }),
  );

  try {
    await expect(
      client.createEvent("test@example.com", newEvent),
    ).rejects.toThrow("Event conflicts with existing event");
  } finally {
    listStub.restore();
  }
});

Deno.test("GoogleCalendarClient - createEvent detects exact overlap", async () => {
  const newEvent = createMockEvent(
    "",
    "Duplicate Event",
    "2024-12-25T10:00:00Z",
    "2024-12-25T11:00:00Z",
  );

  const existingEvent = createMockEvent(
    "existing-event-id",
    "Existing Event",
    "2024-12-25T10:00:00Z",
    "2024-12-25T11:00:00Z",
  );

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const listStub = stub(
    client["calendar"].events,
    "list",
    () => Promise.resolve({ data: { items: [existingEvent] } }),
  );

  try {
    await expect(
      client.createEvent("test@example.com", newEvent),
    ).rejects.toThrow("Event conflicts with existing event");
  } finally {
    listStub.restore();
  }
});

Deno.test("GoogleCalendarClient - createEvent allows adjacent events", async () => {
  // Event from 11:00 to 12:00 (should not conflict with 10:00-11:00)
  const newEvent = createMockEvent(
    "",
    "Adjacent Event",
    "2024-12-25T11:00:00Z",
    "2024-12-25T12:00:00Z",
  );

  const existingEvent = createMockEvent(
    "existing-event-id",
    "Existing Event",
    "2024-12-25T10:00:00Z",
    "2024-12-25T11:00:00Z",
  );

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const listStub = stub(
    client["calendar"].events,
    "list",
    () => Promise.resolve({ data: { items: [existingEvent] } }),
  );

  const insertStub = stub(
    client["calendar"].events,
    "insert",
    (params: any) =>
      Promise.resolve({
        data: {
          ...params.requestBody,
          id: "created-event-id",
        },
      }),
  );

  try {
    const createdEvent = await client.createEvent("test@example.com", newEvent);
    expect(createdEvent.id).toBe("created-event-id");
  } finally {
    listStub.restore();
    insertStub.restore();
  }
});

Deno.test("GoogleCalendarClient - createEvent detects partial overlap (start)", async () => {
  // New event starts during existing event
  const newEvent = createMockEvent(
    "",
    "Partial Overlap Event",
    "2024-12-25T10:30:00Z",
    "2024-12-25T12:00:00Z",
  );

  const existingEvent = createMockEvent(
    "existing-event-id",
    "Existing Event",
    "2024-12-25T10:00:00Z",
    "2024-12-25T11:00:00Z",
  );

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const listStub = stub(
    client["calendar"].events,
    "list",
    () => Promise.resolve({ data: { items: [existingEvent] } }),
  );

  try {
    await expect(
      client.createEvent("test@example.com", newEvent),
    ).rejects.toThrow("Event conflicts with existing event");
  } finally {
    listStub.restore();
  }
});

Deno.test("GoogleCalendarClient - createEvent detects partial overlap (end)", async () => {
  // New event ends during existing event
  const newEvent = createMockEvent(
    "",
    "Partial Overlap Event",
    "2024-12-25T09:00:00Z",
    "2024-12-25T10:30:00Z",
  );

  const existingEvent = createMockEvent(
    "existing-event-id",
    "Existing Event",
    "2024-12-25T10:00:00Z",
    "2024-12-25T11:00:00Z",
  );

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const listStub = stub(
    client["calendar"].events,
    "list",
    () => Promise.resolve({ data: { items: [existingEvent] } }),
  );

  try {
    await expect(
      client.createEvent("test@example.com", newEvent),
    ).rejects.toThrow("Event conflicts with existing event");
  } finally {
    listStub.restore();
  }
});

Deno.test("GoogleCalendarClient - createEvent detects enclosing conflict", async () => {
  // New event completely encloses existing event
  const newEvent = createMockEvent(
    "",
    "Enclosing Event",
    "2024-12-25T09:00:00Z",
    "2024-12-25T12:00:00Z",
  );

  const existingEvent = createMockEvent(
    "existing-event-id",
    "Existing Event",
    "2024-12-25T10:00:00Z",
    "2024-12-25T11:00:00Z",
  );

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const listStub = stub(
    client["calendar"].events,
    "list",
    () => Promise.resolve({ data: { items: [existingEvent] } }),
  );

  try {
    await expect(
      client.createEvent("test@example.com", newEvent),
    ).rejects.toThrow("Event conflicts with existing event");
  } finally {
    listStub.restore();
  }
});

Deno.test("GoogleCalendarClient - deleteEvent deletes successfully", async () => {
  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  let deleteCalled = false;
  const deleteStub = stub(
    client["calendar"].events,
    "delete",
    (params: any) => {
      expect(params.calendarId).toBe("test@example.com");
      expect(params.eventId).toBe("event-to-delete");
      deleteCalled = true;
      return Promise.resolve({ data: {} });
    },
  );

  try {
    await client.deleteEvent("test@example.com", "event-to-delete");
    expect(deleteCalled).toBe(true);
  } finally {
    deleteStub.restore();
  }
});

Deno.test("GoogleCalendarClient - addCalendarToList adds calendar", async () => {
  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const insertStub = stub(
    client["calendar"].calendarList,
    "insert",
    (params: any) =>
      Promise.resolve({
        data: {
          ...mockCalendarListItem,
          id: params.requestBody.id,
        },
      }),
  );

  try {
    const calendar = await client.addCalendarToList("shared-calendar@example.com");
    expect(calendar.id).toBe("shared-calendar@example.com");
  } finally {
    insertStub.restore();
  }
});

Deno.test("GoogleCalendarClient - getCalendar retrieves calendar info", async () => {
  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const getStub = stub(
    client["calendar"].calendars,
    "get",
    (params: any) =>
      Promise.resolve({
        data: {
          kind: "calendar#calendar",
          id: params.calendarId,
          summary: "Test Calendar",
          timeZone: "UTC",
        },
      }),
  );

  try {
    const calendar = await client.getCalendar("test@example.com");
    expect(calendar.id).toBe("test@example.com");
    expect(calendar.summary).toBe("Test Calendar");
  } finally {
    getStub.restore();
  }
});

Deno.test("GoogleCalendarClient - conflict error includes event details", async () => {
  const newEvent = createMockEvent(
    "",
    "Conflicting Event",
    "2024-12-25T10:30:00Z",
    "2024-12-25T11:30:00Z",
  );

  const existingEvent = createMockEvent(
    "existing-event-id",
    "Important Meeting",
    "2024-12-25T10:00:00Z",
    "2024-12-25T11:00:00Z",
  );

  const client = new GoogleCalendarClient({
    keyFilePath: "./google-account-key.json",
  });

  const listStub = stub(
    client["calendar"].events,
    "list",
    () => Promise.resolve({ data: { items: [existingEvent] } }),
  );

  try {
    await client.createEvent("test@example.com", newEvent);
    throw new Error("Should have thrown conflict error");
  } catch (error: any) {
    expect(error.message).toContain("Important Meeting");
    expect(error.message).toContain("2024-12-25T10:00:00Z");
    expect(error.message).toContain("2024-12-25T11:00:00Z");
    expect(error.conflictingEvent).toBeDefined();
    expect(error.conflictingEvent.summary).toBe("Important Meeting");
  } finally {
    listStub.restore();
  }
});
