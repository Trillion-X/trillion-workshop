// tools/tell-ais-how-to-act/do-work/read-how-ais-are-told.mjs
//
// The container tool `tool:read-how-ais-are-told` (tool-rows.json): reads the rows an AI is told when it first
// connects (../rows.json). With no id it answers every row's id, order, whether it is on, where it reaches and how
// long it is; with an id it answers that row whole. It changes nothing: a person changes what their own AIs are
// told with their own setting records, never by editing this file's answer.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROWS = new URL('../rows.json', import.meta.url);

// The `ai-instruction` rows of a rows file, in the order they are told.
export function instructionRows(file = ROWS) {
  const kept = JSON.parse(readFileSync(file, 'utf8')).records ?? [];
  return kept.map(record => record.payload).filter(payload => payload?.kind === 'ai-instruction').sort((a, b) => a.order - b.order);
}

// { rows: [{ id, order, on, reaches, bytes }], count } or, with an id, { row } whole.
export function readRows({ id, file } = {}) {
  const rows = instructionRows(file);
  if (id === undefined || id === null || id === '') {
    return { rows: rows.map(row => ({ id: row.id, order: row.order, on: row.on !== false, reaches: row.reaches ?? ['initialize'], bytes: Buffer.byteLength(row.text) })), count: rows.length };
  }
  const row = rows.find(candidate => candidate.id === id);
  if (!row) throw new Error(`No instruction row has the id ${id}. Read with no id to list them.`);
  return { row };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    console.log(JSON.stringify(readRows(raw ? JSON.parse(raw) : {})));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
