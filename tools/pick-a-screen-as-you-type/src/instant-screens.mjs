// src/instant-screens.mjs
//
// PURPOSE
//   As a person types what they want, the screen that already does it, picked on their own device in well under a
//   frame, with no model: "timer 25 min" opens the timer they saved with 25 minutes in it, "lunch with Ruth tomorrow"
//   opens their calendar's new-event screen filled. The catalog is OPEN: every screen the person is offered (the app's
//   own, each tool's, each Marketplace tool they installed, each screen an AI saved with `screen.asked`), every
//   interface of controls an AI made (src/made-controls.mjs, by its intent) and every screen the person kept from here
//   (by their words). A screen an AI makes for some words is saved with them, so the same words next time pick it at
//   once: the instant answer gets better every time an AI makes a screen.
//   The pick is shown at once; the screen's inputs are then filled from the words by the one parser registry
//   (src/input-parsers.mjs). This file is pure (no page, no store): src/workspace/instant-screen.tsx draws it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no screen, tool or input is named here. Candidates are the rows their owners supply.
//   2. Every weight, threshold, bound and word is DATA (instant-screens.json).
//   3. Calm: a different screen replaces the one shown only after it wins `decide.challenger_wins` times in a row
//      (or at `challenger_override`); a screen the person chose stays until their words change substantially.
//   4. Bounded: one keystroke weighs at most `candidates_max` screens; answers are remembered for at most
//      `remembered_answers` texts; the person's kept screens are at most `asks.max`, each with at most `asks.words_max`
//      characters of words.
//   5. Words match through the one word matcher (src/word-match.mjs).
//
// Shapes
//   catalogOf({ rows, made, asks }) -> catalog            rows: offered screen rows; made: [{ interface_id, title, intent }];
//                                                         asks: the kept screens (keptAsks)
//   rank(catalog, text) -> { text, picks: [{ entry, score, matched: [[at, end]] }] }   best first
//   decide(memory, ranked) -> memory                      memory: { shown, challenger, forced } (NO_PICK to start)
//   choose(entry, text) -> memory                         the person chose this screen for these words
//   createAnswers(limit) -> { get(key), set(key, value), clear() }   bounded answers, least recently used let go
//   keptAsks(value) -> [ask]; keepAsk(asks, ask, now) / renameAsk(asks, id, label) / removeAsk(asks, id) -> asks

import settings from './instant-screens.json' with { type: 'json' };
import parserWords from './input-parsers.json' with { type: 'json' };
import { isCommonWord, stemOf, termsOf } from './word-match.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');
export const normalWords = value => termsOf(value).map(term => term.word).join(' ');

// The words a value can be (a day, a unit, a number word): a typed word that is one of these is filling an input, so a
// screen is not weighed down for not holding it (src/input-parsers.json).
const VALUE_WORDS = new Set([
  ...Object.keys(parserWords.relative_days), ...parserWords.weekdays, ...parserWords.months, ...parserWords.next_words,
  ...parserWords.in_words, ...parserWords.at_words, ...Object.keys(parserWords.day_parts), ...Object.keys(parserWords.meridiem),
  ...Object.keys(parserWords.duration_units), ...Object.keys(parserWords.number_scales), ...Object.keys(parserWords.number_words),
  ...Object.keys(parserWords.currencies), ...parserWords.switch_off_words, ...parserWords.person_lead_words,
].map(word => stemOf(word.toLowerCase())));
const isValueWord = term => /^\p{N}/u.test(term.raw) || VALUE_WORDS.has(term.word) || parserWords.weekdays.some(day => term.raw.length >= 3 && day.startsWith(term.raw));

const wordsOfField = value => termsOf(value).filter(term => !isCommonWord(term.raw));

/** One candidate: what opens (`screen`, with `input`), what it is called, and the words it is found by. */
function entryOf({ key, kind, screen, input = {}, label, icon, about = '', asked = [], source }) {
  return {
    key, kind, screen, input, label, ...(icon ? { icon } : {}), about, asked, source,
    terms: { label: wordsOfField(label), about: wordsOfField(about), asked: asked.flatMap(wordsOfField) },
    phrases: new Set(asked.map(normalWords).filter(Boolean)),
  };
}

/** The open catalog (invariant 1): the person's offered screens, their made interfaces and their kept screens, with
 *  every word they are found by indexed once, so a keystroke weighs each distinct word once, not each screen's words. */
export function catalogOf({ rows = [], made = [], asks = [] } = {}) {
  const entries = [];
  for (const ask of asks) {
    if (!text(ask?.id) || !text(ask?.screen) || !text(ask?.words)) continue;
    entries.push(entryOf({ key: `kept:${ask.id}`, kind: 'kept', screen: ask.screen, input: object(ask.input) ? ask.input : {}, label: text(ask.label) || ask.words, ...(text(ask.icon) ? { icon: ask.icon } : {}), asked: [ask.words], source: { ask_id: ask.id } }));
  }
  for (const one of made) {
    if (!text(one?.interface_id) || !text(one?.title)) continue;
    entries.push(entryOf({ key: `made:${one.interface_id}`, kind: 'made', screen: settings.made.screen, input: { [settings.made.input]: one.interface_id }, label: one.title, icon: 'SlidersHorizontal', about: text(one.tool_label), asked: [text(one.intent)].filter(Boolean), source: { workflow_id: one.interface_id } }));
  }
  for (const row of rows) {
    if (!object(row) || !text(row.id) || row.listed === false || typeof row.label !== 'string' || !row.label.trim()) continue;
    const toolId = row.source?.kind === 'tool' ? row.source.tool_id : row.surface_input?.tool_id;
    const asked = Array.isArray(row.asked) ? row.asked.filter(one => typeof one === 'string') : [];
    entries.push(entryOf({ key: `screen:${row.id}`, kind: 'screen', screen: row.id, label: row.label, ...(typeof row.icon === 'string' ? { icon: row.icon } : {}), about: typeof row.description === 'string' ? row.description : '', asked, source: toolId ? { tool_id: toolId, ...(asked.length ? { made: true } : {}) } : {} }));
  }
  const bounded = entries.slice(0, settings.candidates_max);
  // Each distinct word once, with every place it is found: which screen, which field and, for a name, which word.
  const vocabulary = new Map();
  const phrases = new Map();
  bounded.forEach((entry, index) => {
    for (const [field, words] of Object.entries(entry.terms)) {
      words.forEach((word, at) => {
        const known = vocabulary.get(word.raw) ?? { word, found: [] };
        known.found.push({ index, field, at });
        vocabulary.set(word.raw, known);
      });
    }
    for (const phrase of entry.phrases) phrases.set(phrase, [...(phrases.get(phrase) ?? []), index]);
  });
  return { entries: bounded, vocabulary: [...vocabulary.values()], phrases };
}

// Letters apart, stopping once past `most` (a slip of one or two letters is all that counts).
function lettersApart(a, b, most) {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let least = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      least = Math.min(least, current[j]);
    }
    if (least > most) return most + 1;
    previous = current;
  }
  return previous[b.length];
}

/** How much one typed word counts against one word of a screen (settings.match). */
function likeness(typed, theirs, typing) {
  const { match } = settings;
  if (typed.word === theirs.word || typed.raw === theirs.raw) return match.same;
  if (typed.raw.length >= match.starts_letters && (typing || typed.raw.length >= match.starts_letters + 1) && theirs.raw.startsWith(typed.raw)) return match.starts;
  if (typed.raw.length >= match.slip_letters) {
    const apart = lettersApart(typed.raw, theirs.raw, 2);
    if (apart === 1) return match.slip;
    if (apart === 2 && typed.raw.length >= match.two_slips_letters) return match.two_slips;
  }
  return 0;
}

/** Every candidate the words could mean, best first, each with its share (0..1) and the words that matched it. */
export function rank(catalog, typed) {
  const source = String(typed ?? '');
  const all = termsOf(source);
  const terms = all.filter(term => !isCommonWord(term.raw));
  const letters = source.replace(/[^\p{L}\p{N}]/gu, '').length;
  if (letters < settings.min_letters || !terms.length) return { text: source, picks: [] };
  // The last word is still being typed unless a space or a stop follows it.
  const typing = /[\p{L}\p{N}]$/u.test(source);
  const weights = settings.fields;
  // Words said exactly as a screen was asked for: that screen, wholly.
  const exact = new Set(catalog.phrases.get(normalWords(source)) ?? []);
  // For each typed word, the best it earns in each screen; each distinct catalog word is weighed once.
  const best = new Map();
  const labelHits = new Map();
  terms.forEach((term, position) => {
    const last = typing && position === terms.length - 1;
    for (const { word, found } of catalog.vocabulary) {
      const like = likeness(term, word, last);
      if (!like) continue;
      for (const { index, field, at } of found) {
        const got = like * weights[field];
        const scores = best.get(index) ?? new Array(terms.length).fill(0);
        if (got > scores[position]) scores[position] = got;
        best.set(index, scores);
        if (field === 'label') {
          const hits = labelHits.get(index) ?? new Set();
          hits.add(at);
          labelHits.set(index, hits);
        }
      }
    }
  });
  const picks = [];
  for (const index of exact) picks.push({ entry: catalog.entries[index], score: 1, matched: all.map(term => [term.at, term.end]) });
  for (const [index, scores] of best) {
    if (exact.has(index)) continue;
    const entry = catalog.entries[index];
    // A value word (a day, a number, a unit) is filling an input: it counts when the screen holds it, never against.
    const owed = terms.filter((term, position) => scores[position] > 0 || !isValueWord(term)).length;
    const earned = scores.reduce((sum, score) => sum + score, 0);
    const cover = entry.terms.label.length ? (labelHits.get(index)?.size ?? 0) / entry.terms.label.length : 0;
    const score = Math.min(1, (earned / Math.max(owed, 1)) * (1 - settings.label_cover + settings.label_cover * cover));
    picks.push({ entry, score, matched: terms.filter((_term, position) => scores[position] > 0).map(term => [term.at, term.end]) });
  }
  const order = { kept: 0, made: 1, screen: 2 };
  picks.sort((a, b) => b.score - a.score || order[a.entry.kind] - order[b.entry.kind] || a.entry.label.localeCompare(b.entry.label));
  return { text: source, picks: picks.slice(0, settings.alternatives + 1) };
}

/** Nothing picked yet. */
export const NO_PICK = Object.freeze({ shown: null, challenger: null, forced: null });

const changedMuch = (from, to) => lettersApart(from, to, Math.max(from.length, to.length)) > settings.decide.forced_change * Math.max(from.length, to.length, 1);

/** The calm answer for the next words (invariant 3): which pick is shown, and who is waiting to replace it. */
export function decide(memory, ranked) {
  const { show_at, challenger_wins, challenger_override, drop_below } = settings.decide;
  if (!text(ranked.text)) return NO_PICK;
  if (memory.forced && !changedMuch(memory.forced, ranked.text)) {
    const again = ranked.picks.find(pick => pick.entry.key === memory.shown?.entry.key);
    return again ? { ...memory, shown: again } : memory;
  }
  const best = ranked.picks[0];
  const current = memory.shown ? ranked.picks.find(pick => pick.entry.key === memory.shown.entry.key) : null;
  if (!memory.shown) return best && best.score >= show_at ? { shown: best, challenger: null, forced: null } : NO_PICK;
  if (best && best.entry.key === memory.shown.entry.key) return { shown: best, challenger: null, forced: null };
  if (!best || best.score < show_at) {
    // Nothing new is good enough: the screen shown stays while the words still hold it, else it goes.
    return current && current.score >= drop_below ? { shown: current, challenger: null, forced: null } : NO_PICK;
  }
  if (best.score >= challenger_override) return { shown: best, challenger: null, forced: null };
  const wins = memory.challenger?.key === best.entry.key ? memory.challenger.wins + 1 : 1;
  if (wins >= challenger_wins) return { shown: best, challenger: null, forced: null };
  return { shown: current ?? memory.shown, challenger: { key: best.entry.key, wins }, forced: null };
}

/** The person chose this screen for these words: it stays until the words change substantially. */
export const choose = (pick, typed) => ({ shown: pick, challenger: null, forced: String(typed ?? '') });

/** Answers kept for at most `limit` texts, the least recently used let go first (invariant 4). */
export function createAnswers(limit = settings.remembered_answers) {
  const kept = new Map();
  return {
    get(key) {
      if (!kept.has(key)) return undefined;
      const value = kept.get(key);
      kept.delete(key);
      kept.set(key, value);
      return value;
    },
    set(key, value) {
      kept.delete(key);
      kept.set(key, value);
      while (kept.size > limit) kept.delete(kept.keys().next().value);
    },
    clear() { kept.clear(); },
    get size() { return kept.size; },
  };
}

/** The person's kept screens, as their preference holds them (only well-formed rows). */
export function keptAsks(value) {
  const rows = Array.isArray(value?.asks) ? value.asks : [];
  return rows.filter(ask => object(ask) && text(ask.id) && text(ask.screen) && text(ask.words)).slice(0, settings.asks.max);
}

/** Keeps a screen for some words: the same words for the same screen are one kept screen, newest first, bounded. */
export function keepAsk(current, { words, screen, input = {}, label = '', icon = '' }, id, now = new Date()) {
  const said = text(words).slice(0, settings.asks.words_max);
  if (!said || !text(screen)) throw new Error('A kept screen needs its words and the screen they open.');
  const asks = keptAsks(current);
  const same = asks.find(ask => normalWords(ask.words) === normalWords(said) && ask.screen === screen);
  const row = { id: same?.id ?? id, words: said, screen, input: object(input) ? input : {}, label: text(label).slice(0, settings.asks.words_max) || same?.label || said, ...(text(icon) ? { icon } : {}), at: now.toISOString() };
  return { asks: [row, ...asks.filter(ask => ask.id !== row.id)].slice(0, settings.asks.max) };
}

/** Gives a kept screen a new name. */
export function renameAsk(current, id, label) {
  const named = text(label).slice(0, settings.asks.words_max);
  if (!named) throw new Error('A kept screen needs a name.');
  const asks = keptAsks(current);
  if (!asks.some(ask => ask.id === id)) throw new Error('That kept screen is not there any more.');
  return { asks: asks.map(ask => (ask.id === id ? { ...ask, label: named } : ask)) };
}

/** Forgets a kept screen. */
export const removeAsk = (current, id) => ({ asks: keptAsks(current).filter(ask => ask.id !== id) });

export const INSTANT_SCREENS = settings;
