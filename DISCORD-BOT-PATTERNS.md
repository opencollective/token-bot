# Discord Bot Development Patterns

Lessons learned building interactive Discord commands with discord.js.

## 🚫 Never Make API Calls During Interaction Handling

Discord gives you **3 seconds** to respond to an interaction. Any async work (API calls, DB queries, calendar fetches) risks hitting that timeout and showing "This interaction failed".

### Rules:
1. **Pre-cache everything** — fetch data on bot startup and keep it in memory
2. **Invalidate on mutation** — when `/book` creates an event or `/shifts` adds a signup, invalidate the cache
3. **Background refresh** — refresh cache hourly or on a timer, never on user interaction
4. **Zero API calls at interaction time** — all reads come from memory

### Pattern: Room Events Cache (`src/lib/room-events-cache.ts`)
```
Boot: initRoomEventsCache(calIdToRoom) → fetches 4 weeks of events, stores in Map<YYYYMMDD, RoomEvent[]>
Read: getRoomEventsCache().getEventsForDate(date) → instant, from memory
Write: After createEvent/deleteEvent → invalidateRoomEventsCache() → background refresh
```

## 🔄 Interaction Response Patterns

### `interaction.update()` — Preferred
- Updates the original message in-place
- Works for button and select menu interactions
- This is what `/book` uses everywhere — keep it simple

### `interaction.deferUpdate()` + `interaction.editReply()` 
- Use only when you truly cannot respond within 3 seconds
- Shows no visual feedback (user sees nothing happening)
- If you must use this, first `update()` with a loading message, then `editReply()`

### `interaction.showModal()`
- Only works if the interaction has NOT been deferred or replied to yet
- Works from both buttons and select menus
- Must be the FIRST response to the interaction

### `interaction.reply()` / `interaction.deferReply()`
- Creates a NEW message (doesn't update the existing one)
- Use for slash command initial responses

### Avoid:
- `deferUpdate()` then silence → user sees nothing, thinks it's broken
- Multiple API calls between receiving interaction and responding
- `showModal()` after any other response method

## 📋 Select Menu vs Buttons

### Use Select Menus (dropdowns) when:
- More than 5 options
- Options are data-driven (dates, times, items)
- You want descriptions on each option

### Use Buttons when:
- 2-5 clearly labeled actions
- Confirm/Cancel flows
- Navigation (Back, Cancel)

### Key limit: 25 options max per select menu

## 🏗 Architecture: Shared Cache Module

Keep the cache as a standalone module (`src/lib/room-events-cache.ts`):
- `getEventsForDateRange(startDate, endDate, calendarIds)` — the core fetcher (testable, accepts mock client)
- `initRoomEventsCache(calIdToRoom)` — boot once
- `getRoomEventsCache()` — returns accessor with `.getEventsForDate()`, `.getEventsForSlot()`, `.getEventCountForDate()`
- `invalidateRoomEventsCache()` — call after any calendar mutation

Consumers (`/shifts`, `/book`, `/cancel`) import only `getRoomEventsCache()` and `invalidateRoomEventsCache()`.

## 🧪 Testing

- Always write unit tests with mocked calendar clients
- The `getEventsForDateRange` function accepts an optional `calendarClient` param for DI
- Test: timed events, all-day events, multi-calendar aggregation, error handling, missing data
- Don't rely on integration tests with real API credentials in CI

## 📅 Google Calendar Gotchas

- **All-day events** use `start.date` (YYYY-MM-DD string), not `start.dateTime`
- **Timed events** use `start.dateTime` (ISO string with timezone)
- Always handle both: `event.start.dateTime || (event.start as any).date`
- Calendar IDs from products.json include `@group.calendar.google.com` suffix — don't truncate
- `singleEvents: true` is required to expand recurring events

## 🔑 Discord.js Type Safety

- Use specific types (`ButtonInteraction`, `StringSelectMenuInteraction`) not the broad `Interaction` union
- `interaction.update()` exists on `MessageComponentInteraction` but not `ChatInputCommandInteraction`
- `interaction.editReply()` exists on all except `AutocompleteInteraction`
- When a function handles multiple interaction types, use a helper like `updateMessage()` with type guards
