# Google Calendar API - How It Works

## Two Different APIs

### 1. Calendar API (`calendars.*`)
- **Direct access** to any calendar you have permission to
- Works with the calendar ID directly
- Doesn't require the calendar to be in your list

```typescript
// This works for ANY calendar you have permission to access
const calendar = await client.getCalendar("shared-calendar@gmail.com");
const events = await client.listEvents("shared-calendar@gmail.com", startDate, endDate);
```

### 2. Calendar List API (`calendarList.*`)
- Lists calendars you're **subscribed to**
- Like "My Calendars" in the Google Calendar UI
- Only shows calendars you've explicitly added

```typescript
// This only returns calendars in your "subscription list"
const calendars = await client.listCalendars();
```

## The Workflow

```
┌─────────────────────────────────────────────────────────────┐
│ Someone shares calendar with service account                │
│ opencalendar@opencalendar-482019.iam.gserviceaccount.com   │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │ Permission Granted     │  ← Can access by ID
         │ BUT not subscribed     │     ✓ getCalendar(id)
         │                        │     ✓ listEvents(id, ...)
         └────────┬───────────────┘     ✓ createEvent(id, ...)
                  │                     ✗ Won't show in listCalendars()
                  │
                  ▼
      ┌──────────────────────────┐
      │ Add to calendar list     │
      │ (subscribe/add shortcut) │
      └──────────┬───────────────┘
                 │
                 ▼
    ┌───────────────────────────┐
    │ Now in subscription list  │   ← Shows in listCalendars()
    │ Can access by ID or list  │     ✓ All of the above
    └───────────────────────────┘     ✓ Shows in listCalendars()
```

## Why This Happens

### Analogy: Shared Google Docs

| Action | Google Drive | Google Calendar |
|--------|--------------|-----------------|
| Someone shares with you | Link sent, permission granted | Calendar shared, permission granted |
| You can access it | Open the link directly | Access by calendar ID |
| Shows in your Drive? | ❌ No (until you add it) | ❌ No (until you add to list) |
| Add to your Drive | "Add to My Drive" | `addCalendarToList()` |
| Now shows in listings | ✅ Yes | ✅ Yes |

## When to Use Each Approach

### Use Direct Access (by ID)
When you:
- Know the specific calendar ID
- Don't need to discover calendars
- Want to work with one specific calendar

```typescript
// Just use the calendar ID directly
await client.listEvents("known-calendar-id@gmail.com", start, end);
```

### Use Calendar List
When you:
- Need to discover all available calendars
- Want to list calendars for a user to choose from
- Are building a UI that shows "My Calendars"

```typescript
// Add it first, then it shows in the list
await client.addCalendarToList("calendar-id");
const allCalendars = await client.listCalendars();
```

## Best Practices

### For Production Use

**Option 1: Store calendar IDs in config**
```json
{
  "calendars": {
    "team": "team-calendar@gmail.com",
    "events": "events@example.com"
  }
}
```
Access them directly - no need to add to list.

**Option 2: Auto-discovery with one-time setup**
1. Someone shares calendar with service account
2. Run a setup script once that adds it to the list
3. Your app can now discover it via `listCalendars()`

**Option 3: Hybrid approach** (Recommended)
- Use direct access for known calendars
- Periodically sync shared calendars to the list for discovery
