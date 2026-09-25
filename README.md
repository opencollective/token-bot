# Token Bot

Manage your ERC20 community token from Discord.

## Minting and sending from messages

Three ways to mint, all restricted to server admins and members of the token's minter role
(`minterRoleId` in `settings.json`, e.g. the `CHT-minter` role):

- **`/mint`** — slash command with explicit recipients, amount and description.
- **Right-click a message → Apps → Mint tokens** — recipients are pre-filled with the message author and
  everyone mentioned in it; a modal lets you adjust recipients, amount and description before minting.
- **React with `:mint:`** — the bot replies under the message asking you to confirm minting
  `mintReactionAmount` (default 1) per person for the author and everyone mentioned, excluding yourself.
  **Cancel** (or 5 minutes without an answer) deletes the prompt and removes your reaction.

Anyone can **react with 🪙 (`:coin:`)** to send `sendReactionAmount` (default 1) per person from their own
balance to the author and mentions, with the same confirm/cancel prompt. Set `senderRoleId` on the token to
restrict this to a role (e.g. members).

Every message-based transaction posts to the transactions channel with a link back to the message and adds
the message URL as an `r` tag on the Nostr annotation of the transaction. Those Nostr events are also how the
bot knows a message was already rewarded: a second `:mint:` on the same message is refused, with no local
state to lose on redeploy.

Per-token config in `settings.json`:

```json
{
  "symbol": "CHT", "mintable": true, "minterRoleId": "…",
  "mintEmoji": "mint", "mintReactionAmount": 1,
  "sendEmoji": "🪙", "sendReactionAmount": 1, "senderRoleId": "…"
}
```

`mintEmoji` / `sendEmoji` accept an emoji name, a unicode emoji, an emoji id or `<:name:id>`. If no mintable
token sets them, `:mint:` and 🪙 map to the first mintable token. On startup the bot creates the `:mint:`
emoji (from `assets/mint-emoji.png`) in every guild that needs it; this requires the bot's role to have the
**Create Expressions** permission, otherwise upload the PNG manually under Server Settings → Emoji.
Removing other people's reactions on cancel requires **Manage Messages**.

Optional: set `DISCORD_MESSAGE_CONTENT_INTENT=true` (and enable the Message Content intent in the Discord
developer portal) so reaction mints and sends use the message text as the description. Without it, the
description is generic and only the message link is recorded.

## Cron

You can define minting amount and burning amount in `discord-roles-rewards.json`. 
Then run the cronjob daily:

```
$> deno task cron
```

For a dry run:

```
$> DRY_RUN=true deno task cron
```

For fine controls, you can edit the list of ONLY_USERS or IGNORE_USERS (array of discord display names), and ONLY_ROLES or IGNORE_ROLES (array of role ids) in `src/commands/cron.ts`.

## Running tests

To test the blockchain functions, first run a local blockchain:

```
$> deno task hh:node
```

Then in another terminal you can run:

```
$> deno task test:cron
```

## Shifts on Nostr

`/shifts` sign-ups and cancellations are published to the community relays
(`wss://relay.commonshub.brussels`, backup `wss://relay.commonshub.dev`) with the
conventions of [commonshub.brussels/docs/nostr.md](https://commonshub.brussels/docs/nostr.md),
so the website's day pages and the bot show the same shifts:

- the bot is the **coordinator**: it publishes the kind `31923` occurrence of a slot once
  that slot has its first sign-up (from Discord or the website), and the kind `34550`
  community definition;
- each Discord member gets a key **derived from the bot's `NOSTR_NSEC`** (nothing stored);
  the bot attests it with a kind `31926` (`d = discord:<user id>`) and publishes a kind `0`
  profile for it. RSVPs (kind `31925`, `status` accepted/declined) are signed with that key;
- a sync (`src/lib/shifts-nostr-sync.ts`) keeps the shifts Google Calendar equal to the
  relays every 5 minutes and right after any RSVP arrives live: website sign-ups are
  mirrored into the calendar ("signed up … via nostr"), website cancellations too, and
  calendar sign-ups the relays do not know get an RSVP.

The bot's key must be on the relay's allow-list (`relay.commonshub.brussels/whitelist`,
over Tailscale). Settings live under `nostr` in `shifts-settings.json` (`relays`,
`coordinatorNpub`, `identityProviders`, `enabled`); `DRY_RUN=true` logs instead of publishing.
Pure builders and parsers are in `src/lib/shifts-nostr.ts` and tested in `tests/shifts-nostr.test.ts`.
