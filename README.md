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