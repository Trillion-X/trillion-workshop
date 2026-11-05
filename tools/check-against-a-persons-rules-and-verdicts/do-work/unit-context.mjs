// tools/check-against-a-persons-rules-and-verdicts/do-work/unit-context.mjs
//
// Purpose
//   The film context of a copy line, as DATA a model reads with the line: for a line of narration or other prose, the
//   sentence before and after it in its own text; for an on-screen string, the other strings of the same option spec and
//   the words spoken while it is on screen (from the cut's word-timed transcript). Moved from trillion-launch-video
//   tools/copy-gate/unit-context.mjs one to one; what changed is that the named files' text is handed in (`files`, a map
//   of name to text), so this file reads no file, and its command is one JSON request in, one JSON answer out.
//
//   node do-work/unit-context.mjs < {"sources": S, "files": {"<name>": "<text>"}}   ->   {"result": {"units": [...]}}
//     S: {"text_keys": "<regex>", "spoken_lead_s": N, "units": [{"text": T, "source": X}]}, where X is
//       {"text_file": F}            a .txt/.md file, or a .json/.jsonl file whose string values are searched, or
//       {"spec": F, "words": W}     an option spec; W is optional (no spoken words without it).
//   units: [{"text": T, "context": {...} | null, "why": "..."}]: do-work/check-a-films-copy.mjs takes them as
//   `context`, matched by exact text, and a model row's questions carry them.
//
// Non-negotiable invariants
//   1. A context is read from the named files only. When the text is not found there, the unit's context is null, with
//      the reason; it is never filled from anywhere else. A file not handed in is not found, never read from a disk.
//   2. The judged text itself never appears in its own context.
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { text as readAll } from 'node:stream/consumers';

// The files of this build, by name: the caller's, handed in. A name not among them is not found.
let held = {};
/** Hold `files` ({ name: text }) for the reads that follow; returns them. */
export const holding = (files = {}) => { held = files; return held; };
function readFileSync(file) {
  if (typeof held[file] !== 'string') throw Object.assign(new Error(`${file} was not handed in`), { code: 'ENOENT' });
  return held[file];
}

const sentencesOf = text => text.match(/[^.!?]+(?:[.!?]+["'”)]*|$)/g)?.map(s => s.trim()).filter(Boolean) ?? [text];

function stringsIn(value, keyOk = () => true, key = null, out = []) {
  if (typeof value === 'string') { if (keyOk(key)) out.push(value); }
  else if (Array.isArray(value)) value.forEach(item => stringsIn(item, keyOk, key, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) stringsIn(v, keyOk, k, out);
  return out;
}

/** The sentence before and after `text` within one block of prose; null when the block does not hold it. */
function around(block, text) {
  const units = block.split('\n').map(line => line.replace(/^[>#*\-\s]+/, '').trim()).filter(Boolean).flatMap(sentencesOf);
  const own = sentencesOf(text);
  const at = units.findIndex(unit => unit.includes(own[0]) || own[0].includes(unit));
  if (at < 0) return null;
  const end = at + own.length - 1;
  return { ...(at > 0 ? { before: units[at - 1] } : {}), ...(end + 1 < units.length ? { after: units[end + 1] } : {}) };
}

/** The sentence before and after `text` within the first block of `file` that holds it: a line of a text file, or a
 * string value of a JSON/JSONL file. Context never crosses into another line (another take or option). */
export function contextFromText(file, text) {
  const raw = readFileSync(file, 'utf8');
  const blocks = extname(file) === '.jsonl' ? raw.split('\n').filter(Boolean).flatMap(line => stringsIn(JSON.parse(line)))
    : extname(file) === '.json' ? stringsIn(JSON.parse(raw)) : raw.split('\n');   // a line of a text file is its own block
  const block = blocks.find(b => b.includes(text));
  if (!block) return { context: null, why: `not found in ${file}` };
  const context = around(block, text);
  if (!context) return { context: null, why: `no sentence of ${file} holds the line` };
  return Object.keys(context).length ? { context, why: `sentences around it in ${file}` } : { context: null, why: `the line is all of ${file}` };
}

/** Normalised words of a word-timed transcript: [{word, start, end}] on the timeline (tl_* when present). */
export function wordsOf(file) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(doc) ? doc : doc.segments ? doc.segments.flatMap(s => s.words ?? []) : doc.words ?? [];
  return list.map(w => ({ word: String(w.word ?? w.w ?? w.text ?? '').trim(), start: w.tl_start ?? w.start ?? w.s, end: w.tl_end ?? w.end ?? w.e }))
    .filter(w => w.word && Number.isFinite(w.start) && Number.isFinite(w.end));
}

/** The other on-screen strings of a spec, and the words spoken from `leadS` before it appears until it leaves. */
export function contextFromSpec(file, text, { words = null, textKeys, leadS = 3 } = {}) {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const keyOk = key => key !== null && new RegExp(textKeys).test(key);
  const strings = stringsIn(spec.events ?? [], keyOk);
  if (!strings.includes(text)) return { context: null, why: `not an on-screen string of ${file}` };
  const with_ = [...new Set(strings.filter(s => s !== text && !s.includes(text) && !text.includes(s)))];
  const at = spec.edit?.hold?.at ?? spec.edit?.overlay?.at;
  const seconds = spec.edit?.hold?.seconds ?? spec.duration_s;
  let spoken = null;
  if (words && Number.isFinite(at) && Number.isFinite(seconds)) {
    spoken = wordsOf(words).filter(w => w.end > at - leadS && w.start < at + seconds).map(w => w.word).join(' ') || null;
  }
  const context = { ...(with_.length ? { on_screen_with: with_ } : {}), ...(spoken ? { spoken } : {}) };
  return Object.keys(context).length ? { context, why: `spec ${file}${words ? ` and words ${words}` : ''}` } : { context: null, why: `nothing else in ${file}` };
}

/** The spoken text of a spec's voice take: its words file's `text`, else its words joined in order; null without one. */
export function voiceText(spec) {
  if (!spec.voice?.words) return null;
  const doc = JSON.parse(readFileSync(spec.voice.words, 'utf8'));
  return typeof doc.text === 'string' && doc.text.trim() ? doc.text.trim() : wordsOf(spec.voice.words).map(w => w.word).join(' ') || null;
}

/** Every copy unit an option spec shows or says, each with its context: on-screen strings (keys matching `textKeys`)
 * and each sentence of its voice take. */
export function optionUnits(file, { words = null, textKeys, leadS = 3 } = {}) {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const keyOk = key => key !== null && new RegExp(textKeys).test(key);
  const shown = [...new Set(stringsIn(spec.events ?? [], keyOk))].map(text => ({ text, kind: 'onscreen', ...contextFromSpec(file, text, { words, textKeys, leadS }) }));
  const said = voiceText(spec);
  const spoken = said ? [...new Set(sentencesOf(said))].map(text => {
    const context = around(said, text);
    return { text, kind: 'narrator', context: context && Object.keys(context).length ? context : null, why: `sentences around it in ${spec.voice.words}` };
  }) : [];
  return [...shown, ...spoken];
}

/** Each unit's context from the files handed in; a file that was not handed in gives null context with the reason. */
export function build(sources, files = held) {
  holding(files);
  return sources.units.map(({ text, source }) => {
    let found;
    try {
      found = source.text_file ? contextFromText(source.text_file, text)
        : source.spec ? contextFromSpec(source.spec, text, { words: source.words ?? null, textKeys: sources.text_keys, leadS: sources.spoken_lead_s })
          : { context: null, why: 'no source' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      found = { context: null, why: error.message };
    }
    return { text, ...found };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input = JSON.parse((await readAll(process.stdin)) || '{}');
    if (!input.sources || !Array.isArray(input.sources.units)) throw new Error('usage: {"sources": {"units": [{"text", "source"}], "text_keys"?, "spoken_lead_s"?}, "files": {"<name>": "<text>"}}');
    const units = build(input.sources, input.files ?? {});
    console.log(JSON.stringify({ result: { units, with_context: units.filter(u => u.context).length } }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
