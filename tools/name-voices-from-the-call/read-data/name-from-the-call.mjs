// tools/name-voices-from-the-call/read-data/name-from-the-call.mjs
//
// Purpose
//   Names the voices of a recorded call from the call app's own screen, so a meeting heard as "Someone (voice-2)"
//   becomes "Priya" without anyone enrolling a voice: the accessibility elements of the call window are sampled while
//   the call runs (by the caller: tools/read-what-is-on-screen, or the Mac app's screen reader), `namesSpeaking` reads who the app shows as speaking, the samples
//   become intervals shifted by the app's lag, and `reconcile` lays them over the voices of the recording (the turns
//   tool:who-is-in-this answers). It is tool:name-voices-from-the-call, run on the person's computer as
//     node /opt/records-door/do-work/run-an-export.mjs /opt/name-voices-from-the-call/read-data/name-from-the-call.mjs name
//   Applying a name goes through the account's one name_speaker door, exactly as a voice named by enrolment does; the
//   caller that holds that door hands it in as `call` (the old app's MCP client with the account key is not carried).
//
// Non-negotiable invariants
//   1. Read only on the call app: this reads elements it is handed; it clicks and types nothing. Which element marks a
//      speaker, how a name is cut from it, the lag and every threshold are DATA (read-data/name-from-the-call.json);
//      this file names no app and no control.
//   2. A name needs the evidence of the screen, never a guess: a voice is named only when the app showed that name for
//      at least `sure_share` of the time the voice spoke and for `least_overlap_seconds`; otherwise it stays unnamed and
//      its candidates are listed. A name goes to one voice only (the one with the most overlap), so two voices are
//      never given one person.
//   3. Naming a voice from the screen never overrides a voice already named (enrolled people): only turns whose label
//      matches `unnamed_label` (DATA) are laid over the screen.
//   4. Applying writes through name_speaker with the evidence worded (DATA) and the share and seconds it stood on.
//
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const lower = value => String(value ?? '').toLowerCase();
export const callSettings = () => JSON.parse(readFileSync(path.join(HERE, 'name-from-the-call.json'), 'utf8'));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** The row for `app` (the first whose app_contains matches it, else the first without one), or null. */
export const rowFor = (settings, app) => (settings.apps ?? []).find(row => row.app_contains?.some(part => lower(app).includes(lower(part))))
  ?? (settings.apps ?? []).find(row => !row.app_contains) ?? null;

/** The names the app shows as speaking among `elements` (normalized elements), once each, in the order shown. */
export function namesSpeaking(elements, row) {
  if (!row?.speaking) return [];
  const strips = (row.name?.strip ?? []).map(pattern => new RegExp(pattern, 'giu'));
  const names = [];
  for (const element of elements ?? []) {
    const text = String(element?.[row.speaking.field] ?? '');
    if (!row.speaking.contains_any.some(part => lower(text).includes(lower(part)))) continue;
    const name = strips.reduce((left, pattern) => left.replace(pattern, ''), text).trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Samples ([{ at_ms, names }], any order) as intervals ([{ start_ms, end_ms, name }]): a name shown at one sample lasts
 * until the next sample, or `mostGapMs` when that is later or there is none. Each is shifted back by `lagMs` because the
 * app's picture trails the sound.
 */
export function intervalsOf(samples, { mostGapMs = 5000, lagMs = 0 } = {}) {
  const sorted = [...samples].sort((a, b) => a.at_ms - b.at_ms);
  const intervals = [];
  sorted.forEach((sample, index) => {
    const end = Math.min(sample.at_ms + mostGapMs, sorted[index + 1]?.at_ms ?? Infinity);
    for (const name of sample.names ?? []) intervals.push({ start_ms: Math.max(0, sample.at_ms - lagMs), end_ms: Math.max(0, end - lagMs), name });
  });
  return intervals;
}

const overlap = (a, b) => Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));

/**
 * Which name belongs to which voice. `turns` are [{ start_ms, end_ms, voice }] (a voice is any label that is the same
 * for the same speaker); `intervals` are from intervalsOf. Returns { assignments: [{ voice, name, share, overlap_ms }],
 * unnamed: [{ voice, candidates: [{ name, share }] }] }.
 */
export function reconcile(turns, intervals, { sure_share: sure = 0.6, least_overlap_seconds: least = 3 } = {}) {
  const spoke = new Map(); const shown = new Map();
  for (const turn of turns) {
    spoke.set(turn.voice, (spoke.get(turn.voice) ?? 0) + (turn.end_ms - turn.start_ms));
    for (const interval of intervals) {
      const ms = overlap(turn, interval);
      if (!ms) continue;
      const names = shown.get(turn.voice) ?? new Map();
      names.set(interval.name, (names.get(interval.name) ?? 0) + ms);
      shown.set(turn.voice, names);
    }
  }
  const pairs = [];
  for (const [voice, names] of shown) for (const [name, ms] of names) pairs.push({ voice, name, overlap_ms: ms, share: ms / spoke.get(voice) });
  pairs.sort((a, b) => b.overlap_ms - a.overlap_ms);
  const assignments = []; const usedVoice = new Set(); const usedName = new Set();
  for (const pair of pairs) {
    if (usedVoice.has(pair.voice) || usedName.has(pair.name)) continue;
    if (pair.share < sure || pair.overlap_ms < least * 1000) continue;
    assignments.push({ ...pair, share: Math.round(pair.share * 100) / 100 });
    usedVoice.add(pair.voice); usedName.add(pair.name);
  }
  const unnamed = [...spoke.keys()].filter(voice => !usedVoice.has(voice)).map(voice => ({
    voice,
    candidates: [...(shown.get(voice) ?? [])].map(([name, ms]) => ({ name, share: Math.round((ms / spoke.get(voice)) * 100) / 100 })).sort((a, b) => b.share - a.share),
  }));
  return { assignments, unnamed };
}

export const callTools = {
  /**
   * { turns: [{ start, end, who }] (seconds), samples: [{ at, names? | elements? }] (ms), app?, apply?: { app, since, until } }
   * -> { assignments, unnamed, named? }. With `apply`, each assignment is written through name_speaker.
   */
  async name(input, context = {}) {
    const settings = callSettings();
    if (!Array.isArray(input.turns) || !input.turns.length) throw fail(settings.words.needs_turns);
    if (!Array.isArray(input.samples) || !input.samples.length) throw fail(settings.words.needs_samples);
    const row = rowFor(settings, input.app);
    const samples = input.samples.map(sample => ({ at_ms: Number(sample.at), names: sample.names ?? namesSpeaking(sample.elements, row) }));
    const intervals = intervalsOf(samples, { mostGapMs: settings.sampling.most_gap_seconds * 1000, lagMs: (row?.lag_seconds ?? 0) * 1000 });
    const unnamed = new RegExp(settings.unnamed_label);
    const turns = input.turns.filter(turn => unnamed.test(String(turn.who)))
      .map(turn => ({ start_ms: Number(turn.start) * 1000, end_ms: Number(turn.end) * 1000, voice: String(turn.who) }));
    const found = reconcile(turns, intervals, settings.reconcile);
    if (!input.apply) return found;
    const { app, since, until } = input.apply;
    if (!app || !since || !until) throw fail(settings.words.needs_apply);
    const call = context.call;
    if (typeof call !== 'function') throw fail(settings.words.needs_caller);
    const named = await Promise.all(found.assignments.map(assignment => call('name_speaker', {
      app, speaker: assignment.voice, name: assignment.name, since, until,
      evidence: fill(settings.evidence, { share: `${Math.round(assignment.share * 100)}%`, seconds: Math.round(assignment.overlap_ms / 1000) }),
    }).then(answer => ({ voice: assignment.voice, name: assignment.name, answer }), error => ({ voice: assignment.voice, name: assignment.name, error: String(error.message ?? error) }))));
    return { ...found, named };
  },
};

/** tool:name-voices-from-the-call as the named export run-an-export calls: fn(input, { door }). */
export const name = (input, context = {}) => callTools.name(input, context);
