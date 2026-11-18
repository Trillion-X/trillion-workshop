// src/media-next-edit.mjs
//
// PURPOSE
//   The one thing to make next, shown above the Media section: a format, a few recordings no edit has used yet, and
//   one line saying why. Another moves to the next ranked set; Not now holds until tomorrow; starting the edit chooses
//   again without those recordings.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The ranking is pure: rows, pursuits, scores and the time arrive as data, so it ranks the same in a test and in
//      the person's store.
//   2. Only recordings whose bytes are in the namespace and that no edit uses yet are candidates; a suggestion must be
//      something the person can open and edit now.
//   3. The reason names only what was measured: without a pursuit score it says nothing about pursuits; without words
//      it does not claim speech; without capture times it names no dates.
//   4. Formats, lengths, weights and set sizes are DATA (media-next-edit.json). Ported from media-workspace
//      next-edit-pick.mjs and next-edit-owner.mjs, whose ranking this keeps.
import settings from './media-next-edit.json' with { type: 'json' };

const DAY_MS = 86_400_000;
// How many recordings just put into an edit are remembered as used until the edit itself records them.
const STARTED_KEPT = 1000;
const clamp = value => Math.max(0, Math.min(1, value));

/** Destinations that can take a suggestion, each with the format rule that fits it. */
export function pickDestinations(destinations, config = settings) {
  return (destinations || []).flatMap(destination => {
    const capabilities = new Set(destination.capabilities || []);
    if (!config.destination_capabilities.some(capability => capabilities.has(capability))) return [];
    const rule = config.format_rules.find(row => capabilities.has(row.capability));
    return rule ? [{ ...destination, format_id: rule.format_id }] : [];
  });
}

/** The recordings a suggestion may use: videos whose bytes are here, whose length was measured (so an edit knows where
 *  each clip ends), and that no edit uses yet (nor one just started). */
export const pickCandidates = (rows, started = new Set()) => (rows || []).filter(row => row.media_kind === 'video' && row.stored && Number(row.duration) > 0 && !(row.edits > 0) && typeof row.identity === 'string' && !started.has(row.identity));

/** The text a recording is scored by: its title and the start of what is said in it. */
export function candidateText(row, said, limit) {
  return [row.title || row.name, said].filter(part => typeof part === 'string' && part.trim()).map(part => part.trim()).join('. ').slice(0, limit);
}

function lengthFit(seconds, range) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (seconds < range.min) return clamp(seconds / range.min);
  if (seconds > range.max) return clamp(range.max / seconds);
  return 1;
}

/** Rank candidates and group them into suggestions. pursuitScores: identity -> probability, or null when not read. */
export function rankPicks({ candidates, pursuitScores = null, config = settings, format, now = Date.now() }) {
  const weights = { ...config.weights };
  if (!pursuitScores) {
    const share = weights.pursuit / 3;
    weights.words += share; weights.length += share; weights.recency += share; weights.pursuit = 0;
  }
  const probabilities = pursuitScores ? [...pursuitScores.values()] : [];
  const low = Math.min(...probabilities), high = Math.max(...probabilities);
  const scored = candidates.map(row => {
    const words = Number(row.words) || 0;
    const seconds = Number(row.duration);
    const captured = Number(row.captured_ms);
    const measures = {
      words: clamp(words / config.words_for_full_score),
      length: lengthFit(seconds, format.length_seconds),
      recency: Number.isFinite(captured) && captured > 0 ? Math.pow(0.5, Math.max(0, now - captured) / DAY_MS / config.recency_half_life_days) : 0,
      pursuit: pursuitScores?.has(row.identity) && high > low ? (pursuitScores.get(row.identity) - low) / (high - low) : 0,
    };
    const score = Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * (measures[key] || 0), 0);
    return { row, words, seconds: Number.isFinite(seconds) ? seconds : null, captured: Number.isFinite(captured) && captured > 0 ? captured : null, score };
  }).sort((a, b) => b.score - a.score || String(a.row.identity).localeCompare(String(b.row.identity)));
  const picks = [];
  for (let at = 0; at + config.clips_per_pick <= scored.length && picks.length < config.sets; at += config.clips_per_pick) picks.push(scored.slice(at, at + config.clips_per_pick));
  return picks;
}

const monthDay = time => new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const minutes = seconds => seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.round(seconds % 3600 / 60)} min` : seconds >= 60 ? `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s` : `${Math.round(seconds)} s`;

/** One suggestion as people read it. */
export function describePick({ set, format, destination = null, pursuit = null }) {
  const total = set.reduce((sum, item) => sum + (item.seconds || 0), 0);
  const times = set.map(item => item.captured).filter(Number.isFinite).sort((a, b) => a - b);
  const filmed = times.length ? (monthDay(times[0]) === monthDay(times.at(-1)) ? `filmed ${monthDay(times[0])}` : `filmed ${monthDay(times[0])} to ${monthDay(times.at(-1))}`) : '';
  const reason = [
    pursuit ? `Closest to “${pursuit.title}”` : '',
    total ? `${minutes(total)} together` : '',
    set.every(item => item.words > 0) ? 'you speak in each' : '',
    filmed,
    'none used yet',
  ].filter(Boolean).join(' · ');
  return {
    title: `Make ${/^[aeiou]/i.test(format.label) ? 'an' : 'a'} ${format.label} from these ${set.length} clips`,
    reason,
    format: { id: format.id, label: format.label },
    destination: destination ? { id: destination.id, label: destination.label } : null,
    clips: set.map(({ row, seconds, words, captured }) => ({ identity: row.identity, file: row.file, name: row.name, title: row.title || row.name, duration: seconds, words, captured_ms: captured, bytes: row.bytes, media_type: row.media_type, media_kind: row.media_kind })),
  };
}

/** The local calendar day a dismissal holds for. */
export const dayOf = (time = Date.now()) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/**
 * The suggestion's owner in one person's store.
 * readLibrary(known) -> { revision, rows }     the newest Media rows (media-library.mjs mediaLibraryRecent), or
 *                                              { revision, unchanged: true } when `known` is the revision held
 * readSaid(identities) -> { identity: text }   the start of what is said in each recording
 * pursuits() -> [{ id, title, after?, status? }]
 * score({ state, instructions, criteria }) -> { choice, ranked: [{ id, probability }] }; may throw
 * readState() / writeState(state)              the person's choices: Not now, how far Another moved, the destination
 */
export function makeMediaNextEdit({ config = settings, readLibrary, readSaid, pursuits, score, readState, writeState, destinations = async () => [], now = () => Date.now() }) {
  let kept = null;
  const tryScore = async question => { try { return await score(question); } catch { return null; } };
  const describePursuit = row => [row.title, row.after].filter(Boolean).join('. ');

  async function choose(library, destination, started) {
    const format = config.formats.find(row => row.id === (destination?.format_id ?? config.default_format));
    if (!format) throw new Error(`media-next-edit.json names no format ${destination?.format_id ?? config.default_format}.`);
    const candidates = pickCandidates(library.rows, started);
    // The best few by the measures that need no scoring are scored against the pursuit the format serves.
    const shortlist = rankPicks({ candidates, config: { ...config, sets: Math.ceil(config.score_candidates / config.clips_per_pick) }, format, now: now() }).flat().map(item => item.row);
    let pursuit = null, pursuitScores = null;
    // Pursuits can affect only a shortlist that the scoring branch can use.
    const known = shortlist.length >= 2
      ? (await pursuits().catch(() => [])).filter(row => config.pursuit_statuses.includes(row.status || 'active')) : [];
    if (known.length && shortlist.length >= 2) {
      const statement = destination ? `${format.label} for ${destination.label}` : format.label;
      const served = known.length === 1 ? { choice: known[0].id } : await tryScore({ state: statement, instructions: config.questions.pursuit, criteria: Object.fromEntries(known.map(row => [row.id, describePursuit(row)])) });
      pursuit = known.find(row => row.id === served?.choice) ?? null;
      if (pursuit) {
        const said = await readSaid(shortlist.map(row => row.identity)).catch(() => ({}));
        const scored = await tryScore({ state: describePursuit(pursuit), instructions: config.questions.clip, criteria: Object.fromEntries(shortlist.map(row => [row.identity, candidateText(row, said[row.identity], config.candidate_characters) || row.identity])) });
        if (Array.isArray(scored?.ranked)) pursuitScores = new Map(scored.ranked.map(row => [row.id, row.probability]));
        else pursuit = null;
      }
    }
    const picks = rankPicks({ candidates: pursuitScores ? shortlist : candidates, pursuitScores, config, format, now: now() });
    const named = pursuit ? { id: pursuit.id, title: pursuit.title } : null;
    return { picks: picks.map(set => describePick({ set, format, destination, pursuit: named })), candidates: candidates.length };
  }

  async function read() {
    const state = readState() ?? {}, today = dayOf(now());
    const choices = pickDestinations(await destinations().catch(() => []), config);
    const destination = choices.find(row => row.id === state.destination_id) ?? choices[0] ?? null;
    const shape = row => ({ id: row.id, label: row.label, providerSlug: row.provider_slug ?? row.label });
    const base = { destination: destination ? shape(destination) : null, destinations: choices.map(shape) };
    if (state.dismissed_on === today) return { ...base, state: 'not-now' };
    // The library is asked only whether it changed (its revision); its rows are read again when the choice must be made again.
    let library = await readLibrary(kept?.revision ?? null);
    const started = [...new Set((Array.isArray(state.started) ? state.started : []).filter(item => typeof item === 'string'))].slice(-STARTED_KEPT);
    const key = JSON.stringify([today, library.revision, destination?.id ?? null, [...started].sort()]);
    if (kept?.key !== key) {
      if (library.unchanged) library = await readLibrary(null);
      kept = { key, revision: library.revision, value: await choose(library, destination, new Set(started)) };
    }
    const picks = kept.value.picks;
    if (!picks.length) return { ...base, state: 'nothing-unused', candidates: kept.value.candidates };
    const index = state.shown?.day === today && state.shown?.destination_id === (destination?.id ?? null) ? state.shown.index % picks.length : 0;
    return { ...base, state: 'ready', pick: picks[index], index, count: picks.length };
  }

  async function act(input) {
    const state = readState() ?? {}, today = dayOf(now()), current = (await read()).destination?.id ?? null;
    if (input?.action === 'not-now') writeState({ ...state, dismissed_on: today });
    else if (input?.action === 'another') {
      const shown = state.shown?.day === today && state.shown?.destination_id === current ? state.shown.index + 1 : 1;
      writeState({ ...state, shown: { day: today, destination_id: current, index: shown } });
    } else if (input?.action === 'destination' && typeof input.id === 'string' && input.id) {
      writeState({ ...state, destination_id: input.id, shown: { day: today, destination_id: input.id, index: 0 } });
    } else if (input?.action === 'started') {
      // The clips are in an edit now: the next read chooses again without them (the newest STARTED_KEPT are kept).
      const identities = Array.isArray(input.identities) ? input.identities.filter(item => typeof item === 'string') : [];
      writeState({ ...state, started: [...new Set([...(state.started ?? []), ...identities])].slice(-STARTED_KEPT), shown: { day: today, destination_id: current, index: 0 } });
    } else throw new Error('Choose Another, Not now, a destination, or start the edit.');
    return read();
  }

  return { read, act };
}
