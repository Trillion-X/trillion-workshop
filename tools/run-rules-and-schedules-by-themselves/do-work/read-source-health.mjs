// tools/run-rules-and-schedules-by-themselves/do-work/read-source-health.mjs
//
// The command tool:read-source-health runs in its container: how each source that feeds a person's automations is doing
// (tools/shared-code/src/automation-health.mjs, the old tool:read-source-health). It reads one request on standard input,
// { now, sources } (the same shape the old tool took), and writes the answer as one JSON line.
//
// The states of the sources are decided by the formula engine's row filter, called directly (the Rust module in
// tools/formula-engine/built-stored-bytes), as the old tool did.

import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { initSync, filterRecords } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import { makeSourceHealth } from '../../shared-code/src/automation-health.mjs';
import looks from '../src/automation-health-looks.json' with { type: 'json' };

initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });

const EVERY_ROW = { kind: 'group', combinator: 'and', negate: false, rules: [] };

/** { tree, fields, rows } -> { matches, kept, incomplete }: the row filter the formula engine runs for tool:filter-rows-by-rules. */
export function filterRows({ tree, fields, rows }) {
  const records = rows.map(row => (row && typeof row === 'object' ? row : {}));
  return filterRecords({
    records,
    fields: fields.map(({ id, kind }) => ({ id, kind })),
    tree: tree && typeof tree === 'object' ? tree : EVERY_ROW,
  });
}

const { readSourceHealth } = makeSourceHealth({ looks, filterRows });

async function main() {
  try {
    const request = JSON.parse((await text(process.stdin)) || '{}');
    process.stdout.write(`${JSON.stringify(await readSourceHealth(request))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: { message: String(error.message ?? error) } })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
