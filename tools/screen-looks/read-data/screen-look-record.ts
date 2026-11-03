// tools/screen-looks/read-data/screen-look-record.ts
//
// PURPOSE
//   A look as a record that leaves and enters an app: the same `{ address, payload }` row an app's looks DATA ships
//   (src/workspace/looks.json), so a downloaded look, a look published to the Marketplace, a look an AI made with a tool
//   and a look a phone app reads are one format. Pure: the browser choosers (do-work/screen-look-records.ts) and the
//   Worker's looks owner (src/looks.mjs) read and change looks through these same functions.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A record is decoded only by readScreenLookRecord; anything it refuses is refused here with plain words.
//   2. A change to a look's colours, sizes or fonts goes through changeScreenLookTokens, which keeps each token's own
//      kind and bounds, so a look from anywhere can never carry a value its token cannot take.
//   3. Nothing here names a look, an app or a colour, and nothing here reads or writes storage.

import {
  readScreenLookRecord,
  type EditableScreenLookTheme,
  type EditableScreenLookToken,
} from './read-editable-screen-look-themes.ts';
import { isColour, isSafeText } from './colour-ladder.ts';
import { tintLook } from './tint-look.ts';
import { screenLookScheme } from './look-scheme.ts';
import tintRules from './tint-rules.json' with { type: 'json' };

/** A look's record: the row format of an app's looks DATA. */
export type ScreenLookRecord = { address: string; payload: EditableScreenLookTheme };

export const SCREEN_LOOK_RECORD_ADDRESS_PREFIX = 'package::screen-look::published-record::editable-theme::';

const NOT_A_LOOK = 'This is not a look. Choose a .look.json file downloaded from Screen look.';

/** The record for `theme`, ready to download, publish or hand to another app. */
export function screenLookRecord(theme: EditableScreenLookTheme): ScreenLookRecord {
  return { address: `${SCREEN_LOOK_RECORD_ADDRESS_PREFIX}${theme.id}`, payload: theme };
}

/** The words a look's name becomes in a file name or a new id: lower case, dashes between words. */
export function screenLookSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The file a look downloads as: its record as JSON, named after the look. */
export function screenLookFile(theme: EditableScreenLookTheme): { name: string; type: string; text: string } {
  return { name: `${screenLookSlug(theme.name) || theme.id}.look.json`, type: 'application/json', text: `${JSON.stringify(screenLookRecord(theme), null, 1)}\n` };
}

/** Reads a look record from a file's text or a parsed value; throws with plain words when it is not a look. */
export function readScreenLookFile(record: unknown): EditableScreenLookTheme {
  let value = record;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error(NOT_A_LOOK); }
  }
  const theme = readScreenLookRecord(value);
  if (!theme || !theme.tokens.length) throw new Error(NOT_A_LOOK);
  return theme;
}

/** `theme` with the value of its token `tokenKey` replaced (the editor's one change). */
export function replaceEditableScreenLookToken(
  theme: EditableScreenLookTheme,
  tokenKey: string,
  value: EditableScreenLookToken['value'],
): EditableScreenLookTheme {
  return { ...theme, tokens: theme.tokens.map(token => (token.key === tokenKey ? { ...token, value } : token)) };
}

function acceptedValue(token: EditableScreenLookToken, value: unknown): EditableScreenLookToken['value'] {
  if (token.kind === 'number') {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isFinite(number)) throw new Error(`${token.label} takes a number.`);
    if ((token.min !== undefined && number < token.min) || (token.max !== undefined && number > token.max)) {
      throw new Error(`${token.label} takes a number from ${token.min ?? 'any'} to ${token.max ?? 'any'}.`);
    }
    return number;
  }
  if (!isSafeText(value)) throw new Error(`${token.label} takes a value like ${String(token.value)}.`);
  const text = value.trim();
  if (token.kind === 'color' && !isColour(text)) throw new Error(`${token.label} takes a colour like ${String(token.value)}.`);
  return text;
}

/** `theme` with each token named in `changes` (token key to its new value) set, each checked against its token's kind
 *  and bounds. A key the look has no token for is refused with the keys it has. */
export function changeScreenLookTokens(theme: EditableScreenLookTheme, changes: Record<string, unknown>): EditableScreenLookTheme {
  const byKey = new Map(theme.tokens.map(token => [token.key, token]));
  const unknown = Object.keys(changes).filter(key => !byKey.has(key));
  if (unknown.length) throw new Error(`This look has no ${unknown.join(', ')}. It has: ${[...byKey.keys()].join(', ')}.`);
  return Object.entries(changes).reduce((look, [key, value]) => replaceEditableScreenLookToken(look, key, acceptedValue(byKey.get(key)!, value)), theme);
}

/** `theme` worn in one picked colour: only its hue is kept, and every token tint-rules.json names that the look has is set to
 *  the role's pinned lightness and clamped chroma (tint-look.ts). A token the look lacks is skipped, not an error. */
export function tintScreenLook(theme: EditableScreenLookTheme, colour: string, scheme: string): EditableScreenLookTheme {
  const { changes } = tintLook(colour, scheme);
  const have = new Set(theme.tokens.map(token => token.key));
  return changeScreenLookTokens(theme, Object.fromEntries(Object.entries(changes).filter(([key]) => have.has(key))));
}

/** Whether `theme` is a light or a dark look, read from its first plain-colour ground token (tint-rules.json ground_tokens; light when none is). */
export function schemeOfScreenLook(theme: EditableScreenLookTheme): 'light' | 'dark' {
  for (const key of tintRules.ground_tokens) {
    const value = theme.tokens.find(token => token.key === key)?.value;
    const scheme = screenLookScheme({ ground: typeof value === 'string' ? value : undefined }, 'ground');
    if (scheme) return scheme;
  }
  return 'light';
}
