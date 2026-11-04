// tools/screen-looks/read-data/colour-ladder.ts
//
// PURPOSE
//   What a look does with a value it cannot draw. A look comes from outside (a downloaded file, the Marketplace, an AI), so
//   a colour can be out of range, a number past its own bounds, a text able to close its style rule. Instead of failing the
//   whole look, each such value takes the next rung of a ladder (tools/screen-looks/read-data/colour-ladder.json): the value as given,
//   the same token's colour in the default look, then a neutral grey. Text that is unsafe takes the default, or the token is
//   left out when the default look has none. The look still opens and readable text can never be made unreadable by one bad
//   channel, because a bad colour never reaches the page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and blind: no page, no storage, no look, token or colour named here; ranges, rungs, keywords and the neutral are DATA.
//   2. Degrading never throws and never changes a value that is already valid.
//   3. Refusing is the writer's job (screen-look-record.ts uses isColour to refuse a bad value with words); degrading is the
//      reader's, so the two share one definition of "a colour the screen can draw".
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import ladder from './colour-ladder.json' with { type: 'json' };

export type ColourLadder = typeof ladder;
export type Rung = 'authored' | 'default' | 'neutral';

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?(%|deg|turn|rad|grad)?$/i;
const HEX = /^#[0-9a-f]+$/i;

/** The arguments of `name( … )` split on spaces, commas and a slash, or null when the text is not that function call. */
function argumentsOf(text: string, name: string): string[] | null {
  const open = text.indexOf('(');
  if (open < 1 || !text.endsWith(')') || text.slice(0, open).toLowerCase() !== name) return null;
  const inner = text.slice(open + 1, -1);
  if (/[()]/.test(inner)) return null;
  return inner.split(/[\s,/]+/).filter(Boolean);
}

function inRange(raw: string, [low, high]: readonly number[]): boolean {
  if (!NUMBER.test(raw)) return false;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= low && value <= high;
}

/** Whether `text` is a colour the screen can draw: a hex of a listed length, a colour function with every channel in its
 *  range, a listed keyword, or a function listed as passed through to the browser untouched. */
export function isColour(text: unknown, data: ColourLadder = ladder): boolean {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (!value || new RegExp(data.unsafe_text).test(value)) return false;
  if (value.startsWith('#')) return HEX.test(value) && data.hex_lengths.includes(value.length - 1);
  const name = /^([a-z-]+)\(/i.exec(value)?.[1]?.toLowerCase();
  if (name) {
    if (data.passthrough_functions.includes(name)) return value.endsWith(')');
    const rows = data.functions as Record<string, { channels: number[][]; percent_channels: number[][]; alpha: number[] }>;
    const row = rows[name];
    const args = row ? argumentsOf(value, name) : null;
    if (!row || !args || args.length < 3 || args.length > 4) return false;
    const channelsOk = args.slice(0, 3).every((arg, at) => inRange(arg.replace(/(deg|turn|rad|grad)$/i, ''), arg.endsWith('%') ? row.percent_channels[at] : row.channels[at]));
    const alpha = args[3];
    const alphaOk = alpha === undefined || inRange(alpha.endsWith('%') ? String(Number.parseFloat(alpha) / 100) : alpha, row.alpha);
    return channelsOk && alphaOk;
  }
  return data.keywords.includes(value.toLowerCase());
}

/** The colour a token ends with: the first valid rung of the ladder among the value as authored, the default look's colour for
 *  the same token (`defaultValue`, may be absent) and the neutral. `rung` says which one was taken. */
export function degradeColour(authored: unknown, defaultValue: unknown, data: ColourLadder = ladder): { value: string; rung: Rung } {
  const candidates: Record<Rung, unknown> = { authored, default: defaultValue, neutral: data.neutral };
  for (const rung of data.ladder as Rung[]) {
    if (isColour(candidates[rung], data)) return { value: String(candidates[rung]).trim(), rung };
  }
  return { value: data.neutral, rung: 'neutral' };
}

/** A number inside [min, max]: past a bound it takes that bound. */
export function clampToBounds(value: number, min?: number, max?: number): number {
  const floor = min !== undefined && value < min ? min : value;
  return max !== undefined && floor > max ? max : floor;
}

/** Whether a text value is safe to place in a style rule (it cannot close the rule or leave it). */
export const isSafeText = (text: unknown, data: ColourLadder = ladder): text is string => typeof text === 'string' && text.trim() !== '' && !new RegExp(data.unsafe_text).test(text);
