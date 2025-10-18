import { expect } from "@std/expect/expect";
import { Discord } from "../src/lib/discord.ts";

const discord = Discord.getInstance();
if (!discord) {
  console.error("Discord instance not found");
  Deno.exit(1);
}

Deno.test("getActiveUsers", async () => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const members = await discord.getActiveUsers(
    Deno.env.get("DISCORD_CONTRIBUTIONS_CHANNEL_ID") as string,
    d,
  );
  expect(members).toBeDefined();
  expect(members.length).toBeGreaterThan(0);
  console.log(members);
});

await discord.close();
