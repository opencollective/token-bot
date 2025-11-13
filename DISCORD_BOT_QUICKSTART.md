# Discord.js Bot Quick Start Guide

## 🚀 Running the Bot

### Prerequisites
- Deno installed (v1.40+)
- Discord bot token from [Discord Developer Portal](https://discord.com/developers/applications)
- A Discord server for testing

### Step 1: Setup Environment Variables

Create a `.env` file in the project root:

```env
# Required
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here

# Optional (but recommended for testing)
DISCORD_GUILD_ID=your_test_server_id
DISCORD_TRANSACTIONS_CHANNEL_ID=your_channel_id
```

### Step 2: Register Commands

Before running the bot, register the slash commands:

```bash
deno run --env-file=.env --allow-net --no-prompt src/register-commands.ts
```

Expected output:
```
Started refreshing application (/) commands.
Successfully reloaded application (/) commands.
```

### Step 3: Start the Bot

```bash
deno task bot
```

Expected output:
```
✅ Discord bot logged in as YourBot#1234
```

## ✅ Testing the Bot

### Test 1: Slash Commands

In your Discord server:

1. **Test `/set-cost` command:**
   ```
   /set-cost role: @YourRole amount: 100 frequency: daily
   ```
   Expected: ✅ Cost set for role message

2. **Test `/set-reward` command:**
   ```
   /set-reward role: @YourRole amount: 50 frequency: weekly
   ```
   Expected: ✅ Reward set for role message

### Test 2: Component Interactions

1. **Click buttons:**
   - ➖ Decrements amount (minimum 0)
   - ➕ Increments amount
   - Reset: Sets amount back to 10

2. **Select menus:**
   - Select a role from the role select menu
   - Choose frequency (Daily/Weekly/Monthly)
   - Choose gate option (Yes/No)
   - Select notify role (optional)

3. **Save configuration:**
   - Click "Save" button
   - Should see confirmation message with all settings

## 🔧 Development

### File Structure

```
src/
├── discord-bot.ts          # Main bot file with event handlers
├── commands/
│   ├── set-cost.ts         # Cost command handler
│   ├── set-reward.ts       # Reward command handler
│   └── ...
├── lib/
│   ├── discord.ts          # Discord utility functions
│   └── ...
└── register-commands.ts    # Command registration script
```

### Making Changes

1. **Edit bot logic:**
   - Modify `src/discord-bot.ts`
   - Restart bot (Ctrl+C, then `deno task bot`)

2. **Add new command:**
   - Create new file in `src/commands/`
   - Add handler function
   - Register in `src/register-commands.ts`
   - Re-run registration script

3. **Add new event:**
   - Add event handler in `src/discord-bot.ts`
   - Use `client.on(Events.YourEvent, handler)`

### Example: Adding a Button

```typescript
// In renderPanel()
const row = new ActionRowBuilder<ButtonBuilder>()
  .addComponents(
    new ButtonBuilder()
      .setCustomId("my_custom_id")
      .setLabel("My Button")
      .setStyle(ButtonStyle.Primary)
  );

// In InteractionCreate handler
case "my_custom_id": {
  if (interaction.isButton()) {
    // Handle button click
    await interaction.reply("Button clicked!");
  }
  break;
}
```

## 🐛 Troubleshooting

### Bot won't connect
```bash
# Check token
echo $DISCORD_BOT_TOKEN

# Verify token is valid in Discord Developer Portal
# Check bot has right permissions in server
```

### Commands don't appear
```bash
# Re-register commands
deno run --env-file=.env --allow-net --no-prompt src/register-commands.ts

# Wait 5-10 seconds
# Refresh Discord client (Ctrl+R or Cmd+R)
```

### Interaction times out
- Ensure your reply/deferment happens within 3 seconds
- Check console for error messages
- Add `await` to all async operations

### Type errors
```bash
# Check typescript configuration
deno check src/discord-bot.ts

# Fix any errors, then restart bot
```

## 📊 Monitoring

### View Logs

The bot logs to console. Watch for:

```
✅ Discord bot logged in as BotName#0000  # Good - bot is ready
Error handling interaction: ...           # Error occurred
🛑 Shutting down bot...                 # Graceful shutdown
```

### Common Log Messages

| Message | Meaning |
|---------|---------|
| `Discord bot logged in` | Bot connected successfully |
| `Error handling interaction` | Something went wrong processing a command |
| `Shutting down bot` | Bot is gracefully stopping |

## 🚪 Graceful Shutdown

Stop the bot cleanly with:

```bash
# Keyboard interrupt
Ctrl+C

# Expected output
🛑 Shutting down bot...
(exit code 0)
```

## 🔗 Useful Links

- [Discord.js Docs](https://discord.js.org/)
- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord.js Guide](https://discordjs.guide/)
- [Discord API Docs](https://discord.com/developers/docs/)

## 💡 Next Steps

After testing:

1. **Deploy to production** - See MIGRATION_SUMMARY.md
2. **Add more commands** - Create handlers in src/commands/
3. **Implement persistence** - Store settings in database
4. **Add error tracking** - Integrate Sentry or similar
5. **Monitor performance** - Track latency and uptime

## 📝 Notes

- Bot runs on WebSocket (always connected)
- No HTTP endpoint needed
- Config stored in Map (resets on restart - plan for database)
- All interactions must reply within 3 seconds
- Proper error handling is built-in

Good luck! 🎉
