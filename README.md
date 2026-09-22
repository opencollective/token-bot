# Token Bot

Manage your ERC20 community token from Discord.

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
