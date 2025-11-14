import { loadGuildFile } from "../lib/utils.ts";
import { getYesterdayTransfersSummary, Monitor } from "../lib/etherscan.ts";
import { Discord } from "../lib/discord.ts";

const discord = Discord.getInstance();
if (!discord) {
  console.error("Discord instance not found");
  Deno.exit(1);
}

async function main() {
  const monitors = await loadGuildFile<Monitor[]>("1418496180643696782", "monitors.json");
  if (!monitors) {
    console.error("Monitors not found");
    Deno.exit(1);
  }
  const d = new Date();
  console.log("Script running on", d);

  for (const monitor of monitors) {
    if (monitor.frequency === "daily") {
      const message = await getYesterdayTransfersSummary(monitor);
      if (!message) {
        continue;
      }
      await discord?.postToDiscordChannel(message as string, monitor.channelId);
    }
  }
}

main();
