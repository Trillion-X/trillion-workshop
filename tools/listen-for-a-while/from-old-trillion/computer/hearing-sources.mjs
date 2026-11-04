// computer/hearing-sources.mjs
//
// Purpose
//   Hears the separate recordings of one call (microphone, system sound) each on its own and puts the words back in time
//   order labelled by their source, with a record of how the session was heard. tool:hear-sources runs it.
//
// Non-negotiable invariants
//   1. One hearing pass per source; two sources are never mixed before they are heard.
//   2. The label of a source's words comes from its DATA row; a source not in the table is refused, not guessed. A source marked
//      `me` is the person's own voice, anything else is not (so what others say is information, never an instruction).
//   3. The session record states the program that heard it and the flags in force, with a content id (BLAKE3), and never holds
//      a token or key.
//   4. Sources, labels, record file and words are DATA (hearing-sources.json); this file names none.
//
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (place, home = os.homedir()) => String(place).replace(/^~(?=\/|$)/, home);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
export const sourcesSettings = () => JSON.parse(readFileSync(path.join(HERE, 'hearing-sources.json'), 'utf8'));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Each source is heard by `hear(path) -> { segments: [{ start, end, text }] }` and the words returned in time order:
 * [{ source, speaker, me, start_ms, end_ms, text }]. `at` is the ms time of the start of the recordings.
 */
export async function hearSources(inputs, { hear, settings = sourcesSettings(), at = 0 }) {
  if (!Array.isArray(inputs) || !inputs.length) throw fail(settings.words.needs_sources);
  const rows = inputs.map(input => {
    const row = settings.sources.find(entry => entry.id === input.source);
    if (!row) throw fail(fill(settings.words.unknown_source, { source: input.source, known: settings.sources.map(entry => entry.id).join(', ') }));
    return { input, row };
  });
  const heard = await Promise.all(rows.map(async ({ input, row }) => {
    const value = await hear(input.path);
    return (value.segments ?? []).filter(segment => String(segment.text ?? '').trim()).map(segment => ({
      source: row.id, speaker: row.speaker, me: row.me === true,
      start_ms: at + Math.round(segment.start * 1000), end_ms: at + Math.round(segment.end * 1000), text: segment.text.trim(),
    }));
  }));
  return heard.flat().sort((a, b) => a.start_ms - b.start_ms || a.source.localeCompare(b.source));
}

/** Appends the session's record (program, flags, sources, time) to the record file; returns it. Flags that look like secrets are refused. */
export function recordSession({ program, flags = {}, sources, at = Date.now() }, { settings = sourcesSettings(), file = expand(settings.session_file) } = {}) {
  for (const key of Object.keys(flags)) if (/token|key|secret|password/i.test(key)) throw fail(`The flag ${key} looks like a secret and is not recorded.`);
  const body = { program, flags, sources, at };
  const record = { id: bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(body)))).slice(0, 16), ...body };
  let rows = []; try { rows = JSON.parse(readFileSync(file, 'utf8')).sessions; } catch { /* first session */ }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.part`, `${JSON.stringify({ sessions: [...rows, record].slice(-settings.most_sessions) }, null, 1)}\n`, { mode: 0o600 });
  renameSync(`${file}.part`, file);
  return record;
}

export const hearingSourceTools = {
  /** { sources: [{ source, path }], at?, flags? } -> { words, session } */
  async hear(input) {
    const settings = sourcesSettings();
    const { hearingHere } = await import('../parts/computer-programs/read-data/program-here.mjs');
    const { hearWith } = await import('./keep-drive-files.mjs');
    const rows = JSON.parse(readFileSync(path.join(HERE, 'computer-sources.json'), 'utf8'));
    const program = hearingHere(rows.hearing ?? []);
    if (!program) throw fail(settings.words.no_hearing);
    const words = await hearSources((input.sources ?? []).map(entry => ({ source: entry.source, path: expand(entry.path) })), { hear: file => hearWith(program, file), settings, at: input.at ? Date.parse(input.at) : 0 });
    const session = recordSession({ program: program.id ?? program.produced_by, flags: input.flags ?? {}, sources: [...new Set(words.map(word => word.source))] }, { settings });
    return { words, session };
  },
};
