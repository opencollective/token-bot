import { expect } from "@std/expect/expect";
import {
  _resetReportCache,
  defaultReportChannel,
  findReportByMessage,
  findReportByUri,
  formatMoney,
  formatTransactionReport,
  REPORT_SELECT_ID,
  reportTransaction,
  updateReportCategory,
} from "../src/lib/tx-reports.ts";

const DATA = await Deno.makeTempDir();
Deno.env.set("DATA_DIR", DATA); // settings fall back to the repo's ./data

Deno.test("money: euros with €, tokens with their symbol", () => {
  expect(formatMoney(12.5, "EUR")).toBe("€12.50");
  expect(formatMoney(1234.5, "€")).toBe("€1,234.50");
  expect(formatMoney(80, "EURe")).toBe("€80.00 (EURe)");
  expect(formatMoney(1.5, "CHT")).toBe("1.5 CHT");
});

Deno.test("standard report text: direction, amount, counterparty, time, description, links", () => {
  const text = formatTransactionReport({
    uri: "stripe:txn_1",
    amount: 25,
    currency: "EUR",
    direction: "in",
    counterparty: "Ana  Example",
    description: "Membership\nmonthly",
    links: [{ label: "Stripe", url: "https://dashboard.stripe.com/payments/py_1" }, { label: "bad", url: "javascript:alert(1)" }],
    occurredAt: "2026-09-03T10:00:00Z",
  });
  expect(text).toBe(
    "💰 Received **€25.00** from Ana Example · <t:1788429600:f>\n📝 Membership monthly\n🔗 [Stripe](<https://dashboard.stripe.com/payments/py_1>)",
  );
  expect(formatTransactionReport({ uri: "x:1", amount: 3, currency: "CHT", direction: "out" })).toBe("💸 Sent **3 CHT**");
});

Deno.test("default channel: the token's channel; euros → the euro tokens' channel", async () => {
  expect(await defaultReportChannel("1280532848604086365", "CHT")).toBe("1354115945718878269");
  expect(await defaultReportChannel("1280532848604086365", "EUR")).toBe("1372518467323826259");
  expect(await defaultReportChannel("1280532848604086365", "EURe")).toBe("1372518467323826259");
});

function fakeClient(guildId = "g-report") {
  const sent: { channelId: string; content: string; components: unknown[]; allowedMentions?: unknown }[] = [];
  // deno-lint-ignore no-explicit-any
  const client: any = {
    channels: {
      fetch: (id: string) => Promise.resolve({
        id, guildId, isTextBased: () => true,
        send: (m: { content: string; components: unknown[]; allowedMentions?: unknown }) => {
          sent.push({ channelId: id, ...m });
          const mid = `m${sent.length}`;
          return Promise.resolve({ id: mid, channelId: id, url: `https://discord.com/channels/${guildId}/${id}/${mid}` });
        },
      }),
    },
  };
  return { client, sent };
}

Deno.test("reportTransaction: category line + dropdown, recorded, idempotent by URI", async () => {
  _resetReportCache();
  const { client, sent } = fakeClient();
  const uri = "ethereum:100:tx:0xABC0000000000000000000000000000000000000000000000000000000000001";
  const first = await reportTransaction({ client, channelId: "c1", content: "💰 Received **€5.00**", uris: [uri], currency: "EURe", allowedMentions: { parse: [] } });
  expect(first.alreadyReported).toBe(false);
  expect(sent.length).toBe(1);
  expect(sent[0].content).toBe("💰 Received **€5.00**\n🏷️ Category: Uncategorized");
  expect(sent[0].allowedMentions).toEqual({ parse: [] });
  // deno-lint-ignore no-explicit-any
  const menu = (sent[0].components[0] as any).toJSON().components[0];
  expect(menu.custom_id).toBe(REPORT_SELECT_ID);
  expect(menu.options.some((o: { value: string }) => o.value === "membership")).toBe(true); // euro categories

  // The same transaction again (URI case-insensitive for on-chain): no new post.
  const again = await reportTransaction({ client, channelId: "c1", content: "dup", uris: [uri.toLowerCase()], currency: "EURe" });
  expect(again).toMatchObject({ alreadyReported: true, url: first.url });
  expect(sent.length).toBe(1);

  // Lookups survive a restart (file-backed).
  _resetReportCache();
  expect((await findReportByUri("g-report", uri))?.messageId).toBe("m1");
  const rec = await findReportByMessage("g-report", "m1");
  expect(rec).toMatchObject({ uris: [uri.toLowerCase()], currency: "EURe", category: "uncategorized" });
  await updateReportCategory("g-report", "m1", "membership", "42");
  expect(await findReportByMessage("g-report", "m1")).toMatchObject({ category: "membership", setBy: "42" });
});

Deno.test("reportTransaction: several txs in one report; token categories for tokens", async () => {
  _resetReportCache();
  const { client, sent } = fakeClient("g-multi");
  const uris = ["ethereum:42220:tx:0x01", "ethereum:42220:tx:0x02"];
  const r = await reportTransaction({ client, channelId: "c2", content: "🪙 minted", uris, currency: "CHT", category: "shift" });
  expect(r.record.uris).toEqual(uris);
  expect(sent[0].content.endsWith("🏷️ Category: Shift")).toBe(true);
  // deno-lint-ignore no-explicit-any
  const options = (sent[0].components[0] as any).toJSON().components[0].options.map((o: { value: string }) => o.value);
  expect(options).toContain("governance");
  expect(options).not.toContain("membership");
  expect((await findReportByUri("g-multi", "ethereum:42220:tx:0x02"))?.messageId).toBe("m1");
  await expect(reportTransaction({ client, channelId: "c2", content: "x", uris: [], currency: "CHT" })).rejects.toThrow("at least one transaction URI");
});
