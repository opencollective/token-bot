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

## MCP server (Elinor)

`POST /mcp` is an MCP server over Streamable HTTP. It answers JSON-RPC 2.0 with `application/json`, batches allowed. Notifications get `202`, and `GET`/`DELETE /mcp` return `405` because there is no server stream. Supported protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05`.

**Auth:** `Authorization: Bearer <ELINOR_MCP_TOKEN>`, the token dedicated to Elinor. `API_KEY` is also accepted. Set `ELINOR_MCP_TOKEN` in the bot's environment only.

### Read tools

| Tool | Arguments | Returns |
|---|---|---|
| `check_user_permissions` | `guildId`, `userId` | What the user may do: issue tokens, book rooms, shifts |
| `list_rooms` | `guildId` | Rooms with slug, capacity, hourly prices (euro prices excl. VAT) and `bookableFrom` |
| `check_room_availability` | `guildId`, `room`, `start`, `end` | `available`, overlapping bookings, and `reason` when the start is before `bookableFrom` |
| `list_upcoming_shifts` | `guildId`, `days?` (1–31, default 7) | Shifts with sign-ups and spots left, standard slots, capacity, reward, timezone |
| `get_request_status` | `requestId` | The status of a proposal, below |

### Proposal tools

These never act directly. Each one validates the request, creates a pending request, and posts a message with **Confirm** and **Cancel** buttons. It goes to `channelId`, which can be a channel or a thread in the same server, as a reply to `replyToMessageId` when given. If the bot isn't in a thread it joins it. Without a usable channel it sends a DM, and `deliveryNote` says why. Only the right people's clicks count; anyone else gets an ephemeral notice.

| Tool | Who confirms | On Confirm |
|---|---|---|
| `propose_mint` (`requesterUserId`, `recipientUserIds`, `amount`, `token?`, `description?`, `confirmerUserId?`) | Only members can request. If the requester can mint the token, only they can confirm. Otherwise any minter can approve: the minter role is pinged, or up to 5 admins if there is no role, and this needs a channel. A named `confirmerUserId` must be a minter. The requester can always cancel. | Same as `/mint`, with the clicking minter as minter and the requester as "requested by" |
| `propose_shift_signup` (`userId`, `eventId` or `start`+`end`, `email?`) | The member | Same as `/shifts`: calendar, nostr for standard slots, #shifts log, confirmation email |
| `propose_room_booking` (`userId`, `room`, `start`, `end`, `title`, `guestName?`, `guestEmail?`) | The member | Opens `/book` prefilled at the payment step; the member picks how to pay and confirms there |
| `propose_transaction_category` (`requesterUserId`, `tx`, `chain?`, `category`) | The requesting steward | Publishes the category change signed by their key, the same as the dropdown on transaction reports |

All take `guildId`, `requestedBy` (free text for the audit log), and optional `channelId` and `replyToMessageId`. They return the request status.

**Statuses:** `pending`, `confirmed`, `cancelled`, `expired` (no answer within 24 hours), `failed` (confirmed but execution failed; see `error`), `handed_off` (a room booking continued in `/book`). The status also has `approval` (`confirmer` or `any_minter`), `requesterId`, `confirmedBy` and `cancelledBy`.

Every proposal and outcome is logged in the server's logs channel. A requester can have at most 10 pending requests. Requests are stored in `DATA_DIR/<guildId>/pending-requests.json` and survive restarts.

## Room rules

`products.json` can set `bookableFrom: "HH:MM"`, in the hub's timezone, on a room: bookings can't start earlier. The coworking space has `"bookableFrom": "19:00"`, the same as the website's `rooms.json`. The rule is enforced in `/book`, where earlier start times aren't offered and are rejected if they come in anyway, in `POST /api/book/execute`, and in the MCP tools. The message is "The coworking space can only be booked from 7pm."

## Transaction categories

Every transaction report the bot posts in a transactions channel ends with `🏷️ Category: <label>` and a dropdown. This covers mints, sends, burns, bookings and shift rewards. Bookings start as `rental`, shift rewards as `shift`, and everything else as `none`.

**Who:** admins, the token's minters, and anyone with a role named "… steward". Others get an ephemeral "Only stewards can change the category."

**Categories:** CHT uses governance, cleaning, shift, note-taking, admin, care, rental and none. Euro tokens (EURb, EURchb) use chb's `settings/categories.json`. The dropdown shows 24 common ones plus none; the MCP tool accepts all of them.

**On change:** the bot publishes a kind 1111 annotation per transaction in the message, signed by the steward's own key, to the community relays. It copies the newest existing annotation (description and tags) and replaces only the category:

```json
{
  "kind": 1111,
  "pubkey": "<the steward's key>",
  "content": "Booking Mush Room room for 1h",
  "tags": [
    ["i", "ethereum:42220:tx:0x…"],
    ["k", "ethereum:tx"],
    ["t", "booking"], ["t", "mushroom"],
    ["category", "governance"]
  ]
}
```

`none` is published as `["category","none"]`, which chb knows, so its own rules don't override the steward. For euro transactions the MCP tool takes chb's URIs: `stripe:txn_…` (`k` = `stripe:txn`), `iban:<iban>:tx:<line id>` (`k` = `iban:tx`), and `odoo:<host>:<db>:account.move:<id>` (`k` = `odoo:account.move`). The report is then edited to `🏷️ Category: Governance · set by @steward`, and the change is logged in the logs channel.

**Stewards' keys:** members don't hold Nostr keys. The bot derives one per member, `sha256("token-bot:shift-member:<guildId>:<discordUserId>:<bot secret hex>")`; it is deterministic and never stored, and the shifts RSVPs already use it. The bot attests the key with kind 31926: `d` = `discord:<id>`, `p` = the key, and `role` = `member` and `steward`, plus the guild tags. A profile (kind 0) names it.
