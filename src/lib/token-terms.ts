/**
 * Paying with tokens is not the same service as paying in euros (Xavier's rule).
 * Shown wherever the bot says people can pay with tokens, as fine print. Same wording as the website.
 */

export const COWORKING_TOKEN_TERMS =
  "Contributor coworking (with tokens): use an available desk when capacity is idle; no guaranteed desk, no advance reservation, subject to community activities.";

export const ROOM_TOKEN_TERMS =
  "Rooms booked with tokens: only when capacity is idle, subject to community activities, without cleaning or stewarding.";

/** Euro tokens (EURb, EURe, EURchb…) are paid like euros; the other tokens get the token terms. */
export const isEuroToken = (symbol: string) => /^eur/i.test(symbol);

/** The room terms when this token is not a euro token, else undefined. */
export const roomTermsFor = (symbol: string) => (isEuroToken(symbol) ? undefined : ROOM_TOKEN_TERMS);

/** A line for the calendar event description: "\n<terms>", or "" when paid in euros. */
export const calendarTermsLine = (symbol: string) => (isEuroToken(symbol) ? "" : `\n${ROOM_TOKEN_TERMS}`);

/** Discord fine print: "\n-# …", or "" when paid in euros. */
export const roomFinePrint = (symbol: string) => (isEuroToken(symbol) ? "" : `\n-# ${ROOM_TOKEN_TERMS}`);
