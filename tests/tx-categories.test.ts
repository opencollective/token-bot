import { expect } from "@std/expect/expect";
import {
  categoriesFor,
  categoryLine,
  categoryMenu,
  EURO_CATEGORIES,
  findCategory,
  isSteward,
  parseCategorySelectId,
  replaceCategoryLine,
  TOKEN_CATEGORIES,
  txHashesIn,
  txUriFor,
  withCategory,
} from "../src/lib/tx-categories.ts";
import { buildCategoryAnnotation, kindOfUri, newest } from "../src/lib/category-annotations.ts";
import { resolveTxUri } from "../src/lib/proposals.ts";

const H1 = "0xfab8c02fe66ddc201402ced431bbb9d1b871fbd7892eca8730654ac9b5262e98";
const H2 = "0xab3f1a17b678e46663718ff7f1c223f0bb0b22bddd8911b5a4440591467a0a2e";

Deno.test("category lists: Xavier's token categories; chb's euro ones", () => {
  expect(TOKEN_CATEGORIES.map((c) => c.slug)).toEqual(["governance", "cleaning", "shift", "note-taking", "admin", "care", "rental", "none"]);
  expect(categoriesFor("CHT")).toBe(TOKEN_CATEGORIES);
  expect(categoriesFor("EURb")).toBe(EURO_CATEGORIES);
  expect(EURO_CATEGORIES.length).toBe(44);
  expect(findCategory("EURchb", "Rent")?.slug).toBe("rent");
  expect(findCategory("CHT", "rent")).toBeUndefined();
});

Deno.test("dropdown: ≤ 25 options, current one selected, unknown current kept", () => {
  // deno-lint-ignore no-explicit-any
  const json = (row: any) => row.toJSON().components[0];
  const cht = json(categoryMenu("celo", "CHT", "shift"));
  expect(cht.custom_id).toBe("txcat:celo:CHT");
  expect(cht.options.map((o: { value: string }) => o.value)).toEqual(TOKEN_CATEGORIES.map((c) => c.slug));
  expect(cht.options.find((o: { default?: boolean }) => o.default).value).toBe("shift");
  const eur = json(categoryMenu("gnosis", "EURb", "rental"));
  expect(eur.options.length).toBeLessThanOrEqual(25);
  const odd = json(categoryMenu("gnosis", "EURb", "loan"));
  expect(odd.options[0]).toMatchObject({ value: "loan", default: true });
  expect(json(categoryMenu("celo", "CHT")).options.find((o: { default?: boolean }) => o.default).value).toBe("none");
  expect(parseCategorySelectId("txcat:gnosis:EURb")).toEqual({ chain: "gnosis", tokenSymbol: "EURb" });
  expect(parseCategorySelectId("book_x")).toBeNull();
});

Deno.test("report text: category line added, replaced with who set it; tx hashes read from links", () => {
  const report = `🪙 <@1> minted 1 CHT for <@2> [[tx]](<https://txinfo.xyz/celo/tx/${H1}>)\n🪙 <@1> minted 1 CHT for <@3> [[tx]](<https://celoscan.io/tx/${H2}>)`;
  const { content } = withCategory(report, { chain: "celo", tokenSymbol: "CHT" });
  expect(content.endsWith("\n🏷️ Category: None")).toBe(true);
  const changed = replaceCategoryLine(content, categoryLine("governance", "CHT", "42"));
  expect(changed.endsWith("\n🏷️ Category: Governance · set by <@42>")).toBe(true);
  expect(changed.split("🏷️").length).toBe(2);
  expect(txHashesIn(changed)).toEqual([H1, H2]);
  expect(txUriFor("celo", H1.toUpperCase().replace("0X", "0x"))).toBe(`ethereum:42220:tx:${H1}`);
});

// deno-lint-ignore no-explicit-any
function member(roles: { id: string; name: string }[], admin = false): any {
  const cache = new Map(roles.map((r) => [r.id, r]));
  return {
    permissions: { has: () => admin },
    roles: { cache: { has: (id: string) => cache.has(id), some: (fn: (r: { name: string }) => boolean) => [...cache.values()].some(fn) } },
  };
}

Deno.test("stewards: admins, the token's minters, and any '… steward' role", () => {
  expect(isSteward(member([], true))).toBe(true);
  expect(isSteward(member([{ id: "m", name: "CHT minter" }]), ["m"])).toBe(true);
  expect(isSteward(member([{ id: "k", name: "Kitchen steward" }]))).toBe(true);
  expect(isSteward(member([{ id: "t", name: "Token Steward" }]))).toBe(true);
  expect(isSteward(member([{ id: "c", name: "coworker" }, { id: "s", name: "shifters" }]))).toBe(false);
  expect(isSteward(member([{ id: "x", name: "stewardship fans" }]))).toBe(false);
});

Deno.test("category annotation: keeps the description and tags, swaps the category", () => {
  const current = {
    content: "Booking Mush Room room for 1h",
    tags: [["i", `ethereum:42220:tx:${H1}`], ["k", "ethereum:tx"], ["t", "booking"], ["t", "mushroom"], ["category", "rental"]],
  };
  const now = new Date("2026-10-07T18:00:00Z");
  const ev = buildCategoryAnnotation(`ethereum:42220:tx:${H1}`, "governance", current, now);
  expect(ev).toEqual({
    kind: 1111,
    created_at: 1791396000,
    content: "Booking Mush Room room for 1h",
    tags: [["i", `ethereum:42220:tx:${H1}`], ["k", "ethereum:tx"], ["t", "booking"], ["t", "mushroom"], ["category", "governance"]],
  });
  expect(buildCategoryAnnotation(`ethereum:42220:tx:${H1}`, "none", current, now).tags.filter((t) => t[0] === "category")).toEqual([["category", "none"]]);
  expect(buildCategoryAnnotation("stripe:txn_123", "rental", undefined, now).tags).toEqual([["i", "stripe:txn_123"], ["k", "stripe:txn"], ["category", "rental"]]);
  expect(kindOfUri("ethereum:100:tx:0xabc")).toBe("ethereum:tx");
  expect(kindOfUri("iban:be46734072238636:tx:39976")).toBe("iban:tx");
  expect(kindOfUri("odoo:odoo.example.com:chb:account.move:1234")).toBe("odoo:account.move");
  expect(kindOfUri("bitcoin:tx:abc")).toBe("bitcoin:tx");
  // deno-lint-ignore no-explicit-any
  expect(newest([{ created_at: 1, id: "a" }, { created_at: 3, id: "b" }, { created_at: 2, id: "c" }] as any)?.id).toBe("b");
});

Deno.test("resolveTxUri: hash with chain, or a URI", () => {
  expect(resolveTxUri(H1)).toBe(`ethereum:42220:tx:${H1}`);
  expect(resolveTxUri(H1, "gnosis")).toBe(`ethereum:100:tx:${H1}`);
  expect(resolveTxUri(`ETHEREUM:42220:TX:${H1.toUpperCase()}`)).toBe(`ethereum:42220:tx:${H1}`);
  expect(resolveTxUri("stripe:txn_ABC")).toBe("stripe:txn_ABC");
  expect(() => resolveTxUri("0x1234")).toThrow("Not a transaction hash");
});
