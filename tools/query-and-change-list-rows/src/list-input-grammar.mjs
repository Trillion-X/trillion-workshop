// src/list-input-grammar.mjs
//
// Purpose: read text as a number or a date the way the field that holds it declares, instead of guessing. A field says
// `input: { decimal: "," }` or `input: { date_order: "dmy" }`; "1.250,5" is then 1250.5 and "03/04/2026" is 2026-04-03,
// whoever wrote it (a person's import, an AI filling a value, a formula's input). A field that declares nothing reads
// a whole number written as text ("12") and refuses "1,25" as `ambiguous_number`, never as 1.25 on a guess and never as 125.
//
// Non-Negotiable Invariants:
//   1. Which separators and date orders exist is DATA (src/lists.json `input_grammar`); this file names none.
//   2. A value is never read on a guess: a text that does not fit the declared grammar exactly is refused with the
//      reason that names the field's grammar (the callers' words), not coerced.
//   3. A real number or an ISO date is accepted whatever the field declares: the grammar only reads TEXT.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const grammar = data.input_grammar;
const DATE_PARTS = new RegExp(grammar.date_parts);
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

const isRealDate = (year, month, day) => {
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
};
const pad = (value, width) => String(value).padStart(width, '0');

/** Whether an `input` declaration on a field is one the grammar DATA allows (undefined is fine: nothing declared). */
export function inputDeclarationFits(input) {
  if (input === undefined) return true;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  return keys.length > 0 && keys.every(key => key === 'decimal' || key === 'date_order')
    && (input.decimal === undefined || grammar.decimal.includes(input.decimal))
    && (input.date_order === undefined || grammar.date_order.includes(input.date_order));
}

export const grammarWords = { decimals: grammar.decimal.join(' or '), orders: grammar.date_order.join(', ') };

/**
 * Text as a number under the field's declared decimal separator.
 * Returns { value } or { refused: 'ambiguous_number' | 'bad_number', decimal }.
 */
export function readNumber(text, input) {
  const decimal = input?.decimal;
  const trimmed = String(text).trim();
  // With no declared mark only whole numbers are unambiguous; "1,25" and "1.250" each mean different numbers to different readers.
  if (!decimal) return /^[-+]?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? { value: Number(trimmed) } : { refused: 'ambiguous_number' };
  // The other mark (or a space) groups thousands; the declared one starts the fraction.
  const group = decimal === ',' ? '[. ]' : '[, ]';
  const escaped = decimal === '.' ? '\\.' : decimal;
  const shape = new RegExp(`^[-+]?(?:\\d{1,3}(?:${group}\\d{3})+|\\d+)(?:${escaped}\\d+)?$`);
  if (!shape.test(trimmed)) return { refused: 'bad_number', decimal };
  const plain = trimmed.replace(new RegExp(group, 'g'), '').replace(decimal, '.');
  const value = Number(plain);
  return Number.isFinite(value) ? { value } : { refused: 'bad_number', decimal };
}

/**
 * Text as an ISO date (YYYY-MM-DD) under the field's declared order of day, month and year.
 * A date already written year first is ISO whatever is declared. Returns { value } or { refused: 'bad_date', order }.
 */
export function readDate(text, input) {
  const trimmed = String(text).trim();
  const iso = ISO.exec(trimmed);
  if (iso) return isRealDate(+iso[1], +iso[2], +iso[3]) ? { value: trimmed } : { refused: 'bad_date', order: input?.date_order ?? 'ymd' };
  const order = input?.date_order;
  const parts = order ? DATE_PARTS.exec(trimmed) : null;
  if (!parts) return { refused: 'bad_date', order: order ?? 'ymd' };
  const [a, b, c] = [+parts[1], +parts[2], +parts[3]];
  const [year, month, day] = order === 'dmy' ? [c, b, a] : order === 'mdy' ? [c, a, b] : [a, b, c];
  if (year < 1000 || !isRealDate(year, month, day)) return { refused: 'bad_date', order };
  return { value: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` };
}
