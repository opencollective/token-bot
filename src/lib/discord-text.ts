/**
 * Discord rejects messages over 2000 characters ("Invalid Form Body content[BASE_TYPE_MAX_LENGTH]").
 * Results for many recipients (one tx link each) easily go over, so everything that posts results
 * goes through these helpers.
 */

export const DISCORD_MAX = 2000;

/** Cut `text` to at most `max` characters, at a line (else word) boundary, ending with "…". */
export function clip(text: string, max = DISCORD_MAX): string {
  if (text.length <= max) return text;
  const room = text.slice(0, Math.max(0, max - 1));
  const cut = Math.max(room.lastIndexOf("\n"), room.lastIndexOf(" "));
  return `${cut > max / 2 ? room.slice(0, cut) : room}…`;
}

export type TxItem = { label: string; url: string };

/**
 * One line naming everyone, with as many numbered tx links as fit:
 * "✅ Minted 1 token for @a, @b, @c · txs: [1] [2] [3]", or "· 3 txs" when no link fits.
 */
export function txSummary(lead: string, items: TxItem[], max = DISCORD_MAX): string {
  const head = `${lead} ${items.map((i) => i.label).join(", ")}`;
  const count = ` · ${items.length} tx${items.length === 1 ? "" : "s"}`;
  let links = "";
  for (const [n, item] of items.entries()) {
    const next = `${links || " · txs:"} [${n + 1}](<${item.url}>)`;
    if (head.length + next.length > max) break;
    links = next;
  }
  // All links, or none: a partial list would read as if some had no transaction.
  const tail = links && links.split("](<").length - 1 === items.length ? links : count;
  return clip(head + tail, max);
}

/** One "<lead> <label> [[tx]](<url>)" line per item while it all fits in `max`, else txSummary. */
export function txLines(lead: string, items: TxItem[], max = DISCORD_MAX): string {
  const full = items.map((i) => `${lead} ${i.label} [[tx]](<${i.url}>)`).join("\n");
  return full.length <= max ? full : txSummary(lead, items, max);
}
