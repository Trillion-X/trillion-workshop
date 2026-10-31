// tools/learn-from-everyones-results/read-data/plain-privacy-pass.mjs
//
// The plain privacy pass: what can be found in words meant for strangers without asking a model. Every shared
// situation goes through it twice: on the person's side with their own private terms (their never-publish list, the
// proper names in their own texts), and again at the pool with none, so whatever a sender does, words that carry an
// address, a handle, a long number, an amount of money, a key or a name inside a sentence never enter the pool.
// Ported from the old app's src/private-rewrite.mjs (its plain half; the model rewrite is the caller's and the
// re-identification check is tools/ask-a-small-model-for-a-verdict's).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The patterns, the ordinary words and the always-private words are DATA (./plain-privacy-pass.json): generic
//      dictionaries only (legal entity words, place names). A person's own words come in as `neverPublish` and
//      `known`; none is here.
//   2. `findings` is empty only when no pattern, no private term and no name inside a sentence is left in the words.
//   3. `redact` replaces each finding with the one neutral mark, and the mark itself is a finding: words that still
//      carry it were not rewritten.
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('./plain-privacy-pass.json', import.meta.url), 'utf8'));
const REMOVED = settings.removed_mark;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IDENTIFYING = settings.identifying.map(({ source, flags }) => new RegExp(source, flags));
const MARK = new RegExp(escape(REMOVED), 'i');
const ordinary = new Set(settings.not_identifying.map(word => word.toLowerCase()));
const alwaysPrivate = [...settings.entity_words, ...settings.places].map(word => word.toLowerCase());
const wordPattern = term => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'giu');
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const atSentenceStart = before => before === '' || /[.!?:;"“(\n]$/.test(before);

/**
 * Every word this pass treats as naming someone, lower-cased: the always-private words, each phrase of `neverPublish`
 * (the person's own list of what never leaves), each `known` value the person gave and each of its words of three
 * letters or more, and the proper names found in `texts`: a capitalised word that does not start a sentence and never
 * appears in lower case anywhere in the texts. Ordinary words (`not_identifying`) are never counted.
 */
export function privateTerms({ known = [], texts = [], neverPublish = [] } = {}) {
  const terms = new Set(alwaysPrivate);
  for (const value of neverPublish) if (typeof value === 'string' && value.trim().length >= 2) terms.add(value.trim().toLowerCase());
  for (const value of known.flatMap(strings)) {
    const whole = value.trim().toLowerCase();
    if (whole.length >= 2) terms.add(whole);
    for (const word of whole.split(/[^\p{L}\p{N}]+/u)) if (word.length >= 3 && !ordinary.has(word)) terms.add(word);
  }
  const all = texts.flatMap(strings);
  const lower = new Set(all.flatMap(text => text.match(/(?<![\p{L}\p{N}])\p{Ll}[\p{L}'-]*/gu) ?? []).map(word => word.toLowerCase()));
  for (const text of all) {
    for (const match of text.matchAll(/(?<![\p{L}\p{N}'])\p{Lu}[\p{L}\p{N}'-]*/gu)) {
      const word = match[0].replace(/['-]+$/, '').toLowerCase();
      if (atSentenceStart(text.slice(0, match.index).trimEnd()) || ordinary.has(word) || lower.has(word) || word.length < 2) continue;
      terms.add(word);
    }
  }
  return terms;
}

/** Text with every identifying pattern and every private term replaced by the one neutral mark. */
export function redact(text, terms = new Set()) {
  let out = String(text ?? '');
  for (const pattern of IDENTIFYING) out = out.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), match => (/^\s/.test(match) ? ` ${REMOVED}` : REMOVED));
  for (const term of [...terms].sort((a, b) => b.length - a.length)) out = out.replace(wordPattern(term), REMOVED);
  return out;
}

/** The same shape with every string redacted. */
export function redactAll(value, terms) {
  if (typeof value === 'string') return redact(value, terms);
  if (Array.isArray(value)) return value.map(item => redactAll(item, terms));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactAll(item, terms)]));
  return value;
}

/** Capitalised words inside a sentence: words written in general terms have none besides the ordinary ones. */
export function namesIn(value) {
  const found = [];
  for (const text of strings(value)) {
    for (const match of text.matchAll(/(?<![\p{L}\p{N}'])\p{Lu}[\p{L}\p{N}'-]*/gu)) {
      const word = match[0].replace(/['-]+$/, '');
      if (atSentenceStart(text.slice(0, match.index).trimEnd()) || ordinary.has(word.toLowerCase())) continue;
      found.push(word);
    }
  }
  return found;
}

/** What the plain pass still finds in `value` (any shape): each matching pattern's words, the mark, each private
 * term present and each name inside a sentence. Empty means the plain pass passes. With no terms given, the always-private
 * words still count (the pool's own check, which knows no person). */
export function findings(value, terms = privateTerms()) {
  const found = [];
  for (const text of strings(value)) {
    for (const pattern of [...IDENTIFYING, MARK]) {
      const match = text.match(pattern);
      if (match) found.push(match[0].trim());
    }
    for (const term of terms) if (wordPattern(term).test(text)) found.push(term);
  }
  return [...new Set([...found, ...namesIn(value)])];
}
