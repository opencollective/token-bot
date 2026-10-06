# Token Bot API

HTTP API for external integrations (e.g., other bots, agents) to interact with the token-bot booking system.

## Base URL

```
https://discordbot.opencollective.com
```

## Authentication

All endpoints except `/status.json` require an API key:

```
Authorization: Bearer <API_KEY>
```

## Endpoints

### GET /status.json

Health check and version info. **No authentication required.**

**Response:**
```json
{
  "status": "ok",
  "git": {
    "sha": "abc123def456...",
    "shortSha": "abc123d",
    "message": "feat: add booking API",
    "branch": "main"
  },
  "uptime": 3600,
  "startedAt": "2026-02-14T18:00:00.000Z"
}
```

---

### GET /api/rooms

List all bookable rooms for a guild.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| guildId | string | yes | Discord guild/server ID |

**Example:**
```bash
curl "https://discordbot.opencollective.com/api/rooms?guildId=1280532848604086365" \
  -H "Authorization: Bearer $API_KEY"
```

**Response:**
```json
{
  "rooms": [
    {
      "slug": "satoshiroom",
      "name": "Satoshi Room",
      "capacity": 15,
      "price": [
        { "token": "CHT", "amount": 2 },
        { "token": "EURb", "amount": 50 }
      ]
    },
    {
      "slug": "phonebooth",
      "name": "Phone booth",
      "capacity": 1,
      "price": [
        { "token": "CHT", "amount": 0.5 },
        { "token": "EURb", "amount": 10 }
      ]
    }
  ]
}
```

---

### POST /api/book/availability

Check room availability for a specific date.

**Request Body:**
```json
{
  "guildId": "1280532848604086365",
  "room": "satoshiroom",
  "date": "2026-02-19"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| guildId | string | yes | Discord guild/server ID |
| room | string | yes | Room slug (from /api/rooms) |
| date | string | yes | Date in YYYY-MM-DD format |

**Example:**
```bash
curl -X POST "https://discordbot.opencollective.com/api/book/availability" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"guildId": "1280532848604086365", "room": "satoshiroom", "date": "2026-02-19"}'
```

**Response:**
```json
{
  "room": "Satoshi Room",
  "date": "2026-02-19",
  "events": [
    {
      "summary": "Team Meeting",
      "start": "2026-02-19T10:00:00+01:00",
      "end": "2026-02-19T12:00:00+01:00"
    },
    {
      "summary": "Workshop",
      "start": "2026-02-19T14:00:00+01:00",
      "end": "2026-02-19T16:00:00+01:00"
    }
  ]
}
```

An empty `events` array means the room is fully available that day.

---

### POST /api/book/execute

Execute a room booking. This will:
1. Check user's token balance
2. Burn tokens as payment
3. Create Google Calendar event
4. Post confirmation to Discord channels (#transactions, room channel)
5. Publish Nostr annotation

**Request Body:**
```json
{
  "userId": "849888126",
  "guildId": "1280532848604086365",
  "room": "satoshiroom",
  "start": "2026-02-19T14:00:00",
  "duration": 60,
  "eventName": "Xavier's meeting"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| userId | string | yes | Discord user ID (from verified interaction) |
| guildId | string | yes | Discord guild/server ID |
| room | string | yes | Room slug (from /api/rooms) |
| start | string | yes | Start time in ISO 8601 format |
| duration | number | yes | Duration in minutes |
| eventName | string | no | Name for the calendar event (default: "Room Booking") |

**Example:**
```bash
curl -X POST "https://discordbot.opencollective.com/api/book/execute" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "849888126",
    "guildId": "1280532848604086365",
    "room": "satoshiroom",
    "start": "2026-02-19T14:00:00",
    "duration": 60,
    "eventName": "Team standup"
  }'
```

**Success Response:**
```json
{
  "success": true,
  "txHash": "0x1234567890abcdef...",
  "eventId": "abc123xyz",
  "calendarUrl": "https://calendar.google.com/calendar/embed?src=..."
}
```

**Insufficient Balance Response:**
```json
{
  "success": false,
  "error": "Insufficient balance",
  "balanceRequired": 2.0,
  "balanceAvailable": 0.5,
  "tokenSymbol": "CHT"
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Room not found or not bookable: invalidroom"
}
```

---

## Common Guild IDs

| Guild | ID |
|-------|-----|
| Commons Hub Brussels | `1280532848604086365` |

## Room Slugs (Commons Hub Brussels)

| Room | Slug | Capacity | Price (CHT/h) |
|------|------|----------|---------------|
| Satoshi Room | `satoshiroom` | 15 | 2 |
| Phone booth | `phonebooth` | 1 | 0.5 |
| Mush Room | `mushroom` | 10 | 1 |
| Angel Room | `angelroom` | 12 | 1 |
| Ostrom Room | `ostromroom` | 80 | 3 |
| Coworking | `coworking` | 30 | 2 |

---

## Integration Guide for LLM Agents

### Booking Flow

When a user asks to book a room:

1. **Parse the request** - Extract room name, date, time, and duration from natural language
2. **Validate room** - Call `/api/rooms` to verify room exists and get the slug
3. **Check availability** - Call `/api/book/availability` to ensure slot is free
4. **Show confirmation** - Display booking details and price to user
5. **Execute on confirmation** - When user confirms, call `/api/book/execute`

### Example Conversation

```
User: "Book the Satoshi room tomorrow at 2pm for 2 hours"

Agent: [internally calls /api/book/availability to check]

Agent: "I can book the Satoshi Room for tomorrow (Feb 20th) from 2pm to 4pm.
        
        Price: 4 CHT (2 CHT/hour × 2 hours)
        
        Should I confirm this booking?"

User: "Yes"

Agent: [calls /api/book/execute with userId from Discord interaction]

Agent: "✅ Booked! Satoshi Room, Feb 20th 2-4pm. 
        Transaction: [view](https://gnosisscan.io/tx/0x...)
        Calendar: [view](https://calendar.google.com/...)"
```

### Security Notes

- **Always use `interaction.user.id`** from a verified Discord interaction as the `userId`
- Never allow users to specify a different user ID
- The API trusts that you've verified the user through Discord's interaction system

### Price Calculation

Price is calculated as: `room.price[0].amount × (duration / 60)`

For example:
- Satoshi Room: 2 CHT/hour
- 90 minute booking = 2 × 1.5 = 3 CHT

### Time Format

Use ISO 8601 format for the `start` field:
- `2026-02-19T14:00:00` (local time, server interprets as Europe/Brussels)
- `2026-02-19T14:00:00+01:00` (explicit timezone)
- `2026-02-19T13:00:00Z` (UTC)

### Error Handling

Always check the `success` field in responses:

```javascript
const response = await fetch('/api/book/execute', { ... });
const data = await response.json();

if (data.success) {
  // Show confirmation with txHash and calendarUrl
} else if (data.error === "Insufficient balance") {
  // Tell user they need more tokens
  // data.balanceRequired and data.balanceAvailable have the numbers
} else {
  // Show generic error: data.error
}
```
