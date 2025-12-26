# Google Calendar Usage Patterns

## The Problem: Shared Calendars Don't Auto-Appear

When you share a calendar with the service account:
- ✅ Service account **can access** the calendar (by ID)
- ❌ Calendar **doesn't appear** in `listCalendars()`
- 💡 You need to explicitly "add it to the list" (like "Add to My Drive")

## Solution Patterns

### Pattern 1: Direct Access (No List Needed)
**Best for:** Known calendar IDs, config-driven apps

```typescript
import { GoogleCalendarClient } from "./src/lib/googlecalendar.ts";

const client = new GoogleCalendarClient();

// Just use the calendar ID directly - no setup needed!
const TEAM_CALENDAR = "team-calendar@example.com";

// This works immediately after sharing
const events = await client.listEvents(
  TEAM_CALENDAR,
  new Date("2025-01-01"),
  new Date("2025-12-31")
);

await client.createEvent(TEAM_CALENDAR, {
  summary: "Team Meeting",
  start: { dateTime: "2025-01-20T10:00:00Z" },
  end: { dateTime: "2025-01-20T11:00:00Z" },
});
```

**Pros:**
- No setup required
- Works immediately after sharing
- Simple and direct

**Cons:**
- Need to hardcode or configure calendar IDs
- Can't discover calendars dynamically

---

### Pattern 2: One-Time Setup + Discovery
**Best for:** Apps that need to discover available calendars

```typescript
// Step 1: One-time setup (run after someone shares calendars)
import { GoogleCalendarClient } from "./src/lib/googlecalendar.ts";

const client = new GoogleCalendarClient();

// Add shared calendars to the list (run once)
await client.addCalendarToList("shared-calendar-1@gmail.com");
await client.addCalendarToList("shared-calendar-2@gmail.com");

// Step 2: Now your app can discover them
const calendars = await client.listCalendars();
console.log("Available calendars:", calendars.map(c => c.summary));
```

**Command-line setup:**
```bash
# After someone shares calendars, run this once:
deno task sync-calendars cal1@gmail.com cal2@gmail.com

# Now they appear in list-calendars:
deno task list-calendars
```

**Pros:**
- Can discover calendars dynamically
- Good for user-facing apps with calendar selection

**Cons:**
- Requires one-time setup step
- Need to rerun setup when new calendars are shared

---

### Pattern 3: Auto-Ensure (Hybrid)
**Best for:** Apps that know calendar IDs but want to be defensive

```typescript
import { GoogleCalendarClient } from "./src/lib/googlecalendar.ts";

const client = new GoogleCalendarClient();

// Ensure calendar is in list (adds it if not already there)
await client.ensureCalendarInList("shared-calendar@gmail.com");

// Now you can use it
const calendars = await client.listCalendars();
const events = await client.listEvents("shared-calendar@gmail.com", ...);
```

**Pros:**
- Works whether calendar is in list or not
- Defensive programming
- Good for libraries/reusable code

**Cons:**
- Extra API call on first use
- Slight performance overhead

---

### Pattern 4: Config File Pattern
**Best for:** Production apps with multiple environments

```json
// config/calendars.json
{
  "production": {
    "team": "team@example.com",
    "events": "events@example.com",
    "support": "support@example.com"
  },
  "staging": {
    "team": "team-staging@example.com",
    "events": "events-staging@example.com"
  }
}
```

```typescript
import calendarsConfig from "./config/calendars.json" with { type: "json" };
import { GoogleCalendarClient } from "./src/lib/googlecalendar.ts";

const env = Deno.env.get("ENV") || "production";
const calendars = calendarsConfig[env];

const client = new GoogleCalendarClient();

// Use directly - no list needed
const teamEvents = await client.listEvents(calendars.team, startDate, endDate);
```

**Pros:**
- Environment-specific configuration
- Easy to manage in version control
- No API calls to discover calendars

**Cons:**
- Manual configuration required
- Need to update config when calendars change

---

## Recommended Workflows

### For Development/Testing
```bash
# 1. Create test calendar (instant access)
deno task create-test-calendar

# 2. Share your personal calendar, then add it
deno task test-calendar-access your-email@gmail.com
```

### For Production Setup
```bash
# 1. Share production calendars with:
#    opencalendar@opencalendar-482019.iam.gserviceaccount.com

# 2. Add them to config/calendars.json
{
  "team": "team@yourcompany.com",
  "events": "events@yourcompany.com"
}

# 3. Access directly by ID - no sync needed!
```

### For User-Facing Apps
```bash
# When user shares a calendar:
# 1. Get calendar ID from user
# 2. Add it to the list
deno task sync-calendars user-calendar@gmail.com

# 3. Now it appears in your calendar picker
deno task list-calendars
```

---

## Quick Reference

| Task | Command | When to Use |
|------|---------|-------------|
| List subscribed calendars | `deno task list-calendars` | See what's in the list |
| Test access to specific calendar | `deno task test-calendar-access CAL_ID` | Verify sharing & add to list |
| Add calendars to list | `deno task sync-calendars CAL_ID1 CAL_ID2` | One-time setup for shared calendars |
| Create test calendar | `deno task create-test-calendar` | Testing (auto-appears) |
| Full functionality test | `deno task test-calendar-full` | Test everything works |

---

## Why You Need This Setup

**Think of it like Gmail labels:**
- Someone shares an email with you → You can access it by search
- But it doesn't appear in your inbox until you label it
- `addCalendarToList()` = Adding a label/folder

**Or like Slack channels:**
- Someone adds you to a channel → You have access
- But it doesn't appear in your sidebar until you "star" it
- `addCalendarToList()` = Starring the channel

This design lets service accounts:
- Have access to hundreds of calendars
- But only "subscribe to" the ones they actively use
- Keeping `listCalendars()` fast and manageable
