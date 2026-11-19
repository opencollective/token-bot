/**
 * Linking someone's Discord account and their email address, from the website (both directions:
 * signed in with an email code and linking Discord, or signed in with Discord and adding an email
 * proved with a code). The website has proved both; here we remember it: the bot's user record
 * (users.jsonl: the email used for invoices and organisations) and the Odoo contact (custom fields
 * x_discord_id and x_discord_username, tab "Discord").
 *
 * The contact is the one Odoo already has for that Discord id, else the one with that email.
 * None is created here: chb keeps a member's own partner, and an email sign-in implies a contact.
 */

import type { OdooCall } from "./odoo.ts";
import { likeLiteral } from "./odoo.ts";
import { getUser, saveUser } from "./user-emails.ts";

type Contact = { id: number; email: string | false; x_discord_id?: string | false; x_discord_username?: string | false };

export async function contactByDiscord(odoo: OdooCall, discordId: string): Promise<Contact | null> {
  const found = (await odoo("res.partner", "search_read", { domain: [["x_discord_id", "=", discordId]], fields: ["id", "email", "x_discord_id", "x_discord_username"], limit: 1 })) as Contact[];
  return found[0] ?? null;
}

export async function contactByEmail(odoo: OdooCall, email: string): Promise<Contact | null> {
  const found = (await odoo("res.partner", "search_read", {
    domain: [["email", "=ilike", likeLiteral(email)], ["active", "=", true]],
    fields: ["id", "email", "x_discord_id", "x_discord_username"],
    order: "is_company asc, id asc",
    limit: 5,
  })) as Contact[];
  return found.find((c) => typeof c.email === "string" && c.email.trim().toLowerCase() === email) ?? null;
}

export type LinkInput = { guildId: string; discordId: string; username: string; displayName?: string; email: string };

export async function linkAccount(odoo: OdooCall | null, p: LinkInput): Promise<{ ok: true; partnerId: number | null } | { ok: false; error: string; status: number }> {
  const email = p.email.trim().toLowerCase();
  if (!/^\d{5,25}$/.test(p.guildId) || !/^\d{5,25}$/.test(p.discordId)) return { ok: false, error: "guildId and discordId are required", status: 400 };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "That doesn't look like an email address", status: 400 };
  const username = p.username.replace(/[^\w.]/g, "").slice(0, 40);
  const known = getUser(p.guildId, p.discordId);
  await saveUser(p.guildId, { discordUserId: p.discordId, username: username || known?.username || "", displayName: (p.displayName ?? known?.displayName ?? "").slice(0, 80), email });
  if (!odoo) return { ok: true, partnerId: null };
  const contact = (await contactByDiscord(odoo, p.discordId)) ?? (await contactByEmail(odoo, email));
  if (!contact) return { ok: true, partnerId: null };
  const vals: Record<string, unknown> = { x_discord_id: p.discordId, ...(username ? { x_discord_username: username } : {}) };
  if (!contact.email) vals.email = email;
  await odoo("res.partner", "write", { ids: [contact.id], vals });
  return { ok: true, partnerId: contact.id };
}
