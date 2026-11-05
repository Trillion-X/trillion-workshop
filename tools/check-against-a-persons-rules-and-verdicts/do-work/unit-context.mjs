#!/usr/bin/env node
// tools/copy-gate/unit-context.mjs
//
// Purpose
//   The film context of a copy line, as DATA a decider reads with the line: for a line of narration or other prose, the
//   sentence before and after it in its own text; for an on-screen string, the other strings of the same option spec and
//   the words spoken while it is on screen (from the cut's word-timed transcript).
//
//   node unit-context.mjs build <sources.json> --out <context.json>
//     sources.json: {"text_keys": "<regex>", "spoken_lead_s": N, "units": [{"text": T, "source": S}]}, where S is
//       {"text_file": F}            a .txt/.md file, or a .json/.jsonl file whose string values are searched, or
//       {"spec": F, "words": W}     an option spec; W is optional (no spoken words without it).
//   context.json: {"units": [{"text": T, "context": {...} | null, "why": "..."}]}. check.mjs --context and
//   verdicts.mjs items --context read it.
//
// Non-negotiable invariants
//   1. A context is read from the named files only. When the text is not found there, the unit's context is null, with
//      the reason; it is never filled from anywhere else.
//   2. The judged text itself never appears in its own context.
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function build(sources) {
  return sources.units.map(({ text, source }) => {
    const found = source.text_file ? contextFromText(source.text_file, text)
      : source.spec ? contextFromSpec(source.spec, text, { words: source.words ?? null, textKeys: sources.text_keys, leadS: sources.spoken_lead_s })
        : { context: null, why: 'no source' };
    return { text, ...found };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, input, ...args] = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (command !== 'build' || !input || !out) { console.error('usage: node unit-context.mjs build <sources.json> --out <context.json>'); process.exit(2); }
  const units = build(JSON.parse(readFileSync(input, 'utf8')));
  writeFileSync(out, JSON.stringify({ made: new Date().toISOString(), from: input, units }, null, 1) + '\n');
  console.log(`${out}: ${units.filter(u => u.context).length} of ${units.length} units have context`);
  for (const unit of units.filter(u => !u.context)) console.log(`  no context: ${JSON.stringify(unit.text)} (${unit.why})`);
}
