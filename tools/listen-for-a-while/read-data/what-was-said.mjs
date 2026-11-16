// tools/listen-for-a-while/read-data/what-was-said.mjs
//
// Purpose
//   What is done with a listening's `heard` turns once the caller hands them in. Every function here answers from its
//   request and keeps nothing: the caller's AI reads the turns, the captions and the cursor from wherever it keeps them
//   and takes the new state from the answer.
//   - a voice heard as "Someone (voice-N)" named once that voice is enrolled (`nameHeardVoice`, tool:name-a-heard-voice);
//   - captions: the person's corrections to the turns, as ops over a captions state (`reduceCaptions`, `applyCaptions`,
//     tool:caption-what-is-heard, F-0792);
//   - the transcriber role: one device hears a listening at a time, held until a time in a `{ device, until }` role
//     (`roleHolder`, `mayTranscribe`, F-0793);
//   - the transcript cursor: an ask answers only the turns after what that conversation was last given, from the
//     cursor it hands in (`turnsAfter`, F-0297), and `askWhatWasSaid` (tool:ask-what-was-said) does that with the captions.
//
// Non-negotiable invariants
//   1. Nothing is read or written here but the request and the answer: no row, no file, no state on this computer.
//   2. A rename changes only turns still under "Someone (voice-N)" for one of the voices named; a turn a person already
//      named, an unsure turn and another listening's turn are never changed. The former label stays on the turn.
//   3. Captions never rewrite a heard turn: the person's corrections are beside the words and applied when read, so
//      the words as heard are always there to go back to.
//   4. Every number and word is DATA (read-data/what-was-said.json).
import data from './what-was-said.json' with { type: 'json' };
import { transcriberRoleReader } from './transcriber-role-core.mjs';
import { linesSince } from './transcript-cursor-core.mjs';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const fail = (template, values = {}, status = 400) => Object.assign(new Error(fill(template, values)), { status });

export const HEARD = 'heard';

/** A heard row's start in milliseconds, from its id (`heard:<listening>:<ms>`), so ordering never parses text. */
export const startOf = id => Number(String(id).split(':').at(-1));

/** Every heard row of one listening among the rows handed in, oldest first. */
export const heardOf = (rows, listening) => [rows ?? []].flat().filter(row => row.value?.listening === listening).sort((a, b) => startOf(a.id) - startOf(b.id));

// ---- Naming a voice heard before it was enrolled -------------------------------------------------------------------

/** The rows renamed when `voices` (the labels the enrolled voice was heard under) become `name`: only turns still
 *  under an unknown-voice label, each keeping its former label in `renamed_from`. */
export function renamedRows(rows, { voices, name, me = false }, words = data) {
  const unknown = new RegExp(words.rename.unknown_speaker);
  return rows.filter(row => voices.includes(row.value?.voice) && unknown.test(String(row.value?.speaker ?? '')))
    .map(row => ({ id: row.id, type: HEARD, value: { ...row.value, speaker: name, me: me === true, renamed_from: row.value.speaker } }));
}

/** tool:name-a-heard-voice: { listening, voices, name, me?, heard } -> { listening, name, voices, renamed, rows, said }.
 *  `voices` is the enrol tool's `heard_as` (or one voice-N label); `heard` is the listening's heard rows; `rows` are
 *  the turns that took the name. */
export function nameHeardVoice(input) {
  const listening = String(input?.listening ?? '').trim();
  const name = String(input?.name ?? '').trim();
  const voices = [input?.voices ?? []].flat().map(String).filter(Boolean);
  if (!listening || !name || !voices.length) throw fail(data.words.rename_needs);
  const rows = renamedRows(heardOf(input.heard, listening), { voices, name, me: input.me }, data);
  return { listening, name, voices, renamed: rows.length, rows, said: fill(data.words.renamed, { count: rows.length, name }) };
}

// ---- Captions (F-0792) -----------------------------------------------------------------------------------------------

/** One caption op over the captions state { on, edits: { <heard id>: { text?, speaker?, hidden? } } }:
 *  on | off | edit { id, text } | speaker { id, name } | hide { id } | show { id } | undo { id }. Refuses an unknown op. */
export function reduceCaptions(state, op, words = data.words) {
  const next = { on: state?.on !== false, edits: { ...(state?.edits ?? {}) } };
  const id = String(op?.id ?? '');
  const needsId = ['edit', 'speaker', 'hide', 'show', 'undo'].includes(op?.op);
  if (needsId && !id.startsWith(`${HEARD}:`)) throw fail(words.caption_needs_id, { op: op.op });
  const edit = patch => { next.edits[id] = { ...(next.edits[id] ?? {}), ...patch }; };
  if (op?.op === 'on' || op?.op === 'off') next.on = op.op === 'on';
  else if (op?.op === 'edit') edit({ text: String(op.text ?? '') });
  else if (op?.op === 'speaker') edit({ speaker: String(op.name ?? '') });
  else if (op?.op === 'hide') edit({ hidden: true });
  else if (op?.op === 'show') edit({ hidden: false });
  else if (op?.op === 'undo') delete next.edits[id];
  else throw fail(words.caption_unknown_op, { op: op?.op, ops: data.captions.ops.join(', ') });
  return next;
}

/** The turns as captions: the person's corrections applied, hidden turns left out, the words as heard kept on each. */
export function applyCaptions(rows, state) {
  return rows.flatMap(({ id, value }) => {
    const edit = state?.edits?.[id] ?? {};
    if (edit.hidden) return [];
    return [{ id, start: value.start, end: value.end, speaker: edit.speaker || value.speaker, me: value.me === true, text: edit.text ?? value.text,
      ...(edit.text !== undefined || edit.speaker ? { heard_as: { text: value.text, speaker: value.speaker } } : {}) }];
  });
}

/** tool:caption-what-is-heard: { listening, heard, captions?, ops?, last? } -> { listening, on, captions, lines }: applies
 *  the ops to the captions state handed in and answers the new state (`captions`) and the last `last` captions (DATA default). */
export function captionWhatIsHeard(input) {
  const listening = String(input?.listening ?? '').trim();
  if (!listening) throw fail(data.words.needs_listening);
  let state = { on: input.captions?.on !== false, edits: input.captions?.edits ?? {} };
  for (const op of [input.ops ?? []].flat()) state = reduceCaptions(state, op);
  const last = Math.min(Number(input.last ?? data.captions.last), data.captions.most);
  return { listening, on: state.on, captions: state, lines: state.on ? applyCaptions(heardOf(input.heard, listening), state).slice(-last) : [] };
}

// ---- The transcriber role (F-0793) -----------------------------------------------------------------------------------

/** Who holds the transcriber role now: the role's device while its time has not run out, else null. */
export function roleHolder(row, now = Date.now()) {
  const until = Date.parse(row?.until);
  const at = Number(now);
  if (!row?.device || !Number.isFinite(until) || Number.isNaN(at) || until === at) return null;
  const readRole = transcriberRoleReader({
    readJson: () => ({ who: row.device, beat_ms: until }),
    filesOf: () => ({ role: null }),
    data: { role: { keepalive_ms: 0, lost_after_missed: 1 } },
  });
  return readRole(null, at)?.who ?? null;
}
/** Whether `device` may hear the listening now: nobody holds the role, or it does. */
export const mayTranscribe = (row, device, now = Date.now()) => [null, device].includes(roleHolder(row, now));

// ---- The cursor and the ask (F-0297) ---------------------------------------------------------------------------------

/** The turns after the cursor (the start in milliseconds of the last turn given; none yet when null), oldest first. */
export const turnsAfter = (rows, cursor) => linesSince(rows.map(row => ({ seq: startOf(row.id), row })),
  cursor == null ? -Infinity : Number(cursor)).map(({ row }) => row);

/**
 * tool:ask-what-was-said: { listening, heard, captions?, cursor? } -> { listening, lines, cursor }. Answers the captions of
 * the turns after `cursor` (what this conversation was last given, F-0297, F-0792) and the cursor to hand in next time.
 */
export function askWhatWasSaid(input) {
  const listening = String(input?.listening ?? '').trim();
  if (!listening) throw fail(data.words.ask_needs);
  const fresh = turnsAfter(heardOf(input.heard, listening), input.cursor);
  const cursor = fresh.length ? startOf(fresh.at(-1).id) : input.cursor ?? null;
  return { listening, lines: applyCaptions(fresh, { edits: input.captions?.edits ?? {} }), cursor };
}
