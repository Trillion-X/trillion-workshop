// tools/research-a-creator-or-topic/do-work/keep-new-arc-tabs-in-the-inspiration-library.mjs
//
// Runs on the person's computer. Reads the Arc sidebar file (a copy, so Arc is never written), plans the rows for tabs not
// yet in the library, takes screenshots of the design and site rows with Obscura (two at a time, only while the one-minute
// load is under the gate), and returns the SQL that keeps the rows. The database is written by the workflow through the
// SQL tool, not here, so no database address is on this computer's command line or in this file.
//
//   stdin: { "held": [canonical addresses already in the library], "limit": N, "state_folder": "...", "obscura": "...",
//            "sidebar": "path to StorableSidebar.json" }
//   stdout: one JSON line { outcome, counts, insert_sql, shots: [{ id, name, path, ok }], waited }
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { promisify } from 'node:util';
import { readArcTabs, planIntake } from './arc-inspiration-intake.mjs';
import rules from './arc-inspiration-intake.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const run = promisify(execFile);
const GATE = rules.run_limits.load_gate_one_minute;
const SHOTS_IN_FLIGHT = rules.run_limits.shots_in_flight;
const SHOT_KINDS = new Set(['site', 'component', 'flow']);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sql = text => `'${String(text ?? '').replace(/'/g, "''")}'`;
const sqlOrNull = value => (value === null || value === undefined ? 'NULL' : sql(value));

async function waitForLoad(waited, { oneMinuteLoad, pause }) {
  while (oneMinuteLoad() >= GATE) { waited.count += 1; await pause(60_000); }
}

async function shoot(obscura, url, file) {
  try {
    await run(obscura, ['fetch', url, '--screenshot', file, '--timeout', '30', '--wait', '5', '--quiet'], { timeout: 60_000 });
    return existsSync(file);
  } catch {
    return false;
  }
}

// A shot that worked names its file and stays 'none' until it is kept in Files; one that failed is marked 'failed'.
function shotStatement(shot) {
  const state = shot.ok ? 'none' : 'failed';
  return `update public.inspiration_items set screenshot_file_name = ${sql(shot.name)}, screenshot_state = ${sql(state)} where id = ${sql(shot.id)};`;
}

const INSERT_BATCH = 200;

// One insert statement per 200 rows; a row that is already there is left as it is.
function insertStatements(rows) {
  const cols = ['id', 'url', 'canonical_url', 'title', 'site', 'kind', 'why', 'shows_content', 'space', 'tabs', 'source', 'first_seen', 'provider', 'mine_later', 'tags'];
  const statements = [];
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const values = rows.slice(i, i + INSERT_BATCH).map(r => `(${[
      sql(r.id), sql(r.url), sql(r.canonical_url), sqlOrNull(r.title), sql(r.site), sql(r.kind), sql(r.why),
      r.shows_content ? 'true' : 'false', sql(r.space), String(r.tabs), sql(r.source), sql(r.first_seen),
      sqlOrNull(r.provider), r.mine_later ? 'true' : 'false', `ARRAY[${r.tags.map(sql).join(',')}]::text[]`,
    ].join(',')})`);
    statements.push(`insert into public.inspiration_items (${cols.join(', ')}) values ${values.join(',\n')} on conflict (canonical_url) do nothing;`);
  }
  return statements;
}

export async function keepNewArcTabs(input, { blake3Hex, oneMinuteLoad = () => loadavg()[0], pause = sleep }) {
  const { held = [], pending_shots: pendingShots, limit = rules.run_limits.shots_per_run, state_folder: stateFolder, obscura, sidebar } = input;
  const pending_shots = pendingShots ?? [];
  if (!stateFolder || !obscura || !sidebar) throw new Error('state_folder, obscura and sidebar are required.');
  mkdirSync(stateFolder, { recursive: true });
  // Read a copy: Arc rewrites its own file while it runs.
  const copy = join(stateFolder, 'StorableSidebar.copy.json');
  copyFileSync(sidebar, copy);
  const { tabs } = readArcTabs(readFileSync(copy, 'utf8'));
  const ledgerPath = join(stateFolder, 'ledger.json');
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { seen: [] };
  const known = new Set([...held, ...ledger.seen]);
  const firstSeen = new Date().toISOString();
  const { rows, counts } = planIntake({ tabs, heldCanonicals: known, blake3Hex, firstSeen });

  // Rows still waiting for a shot from earlier runs come first; the caller reads them from the library.
  const waiting = pending_shots.map(p => ({ id: p.id, url: p.url, kind: p.kind, site: p.site }));
  const shotRows = [...waiting, ...rows.filter(r => r.shows_content && SHOT_KINDS.has(r.kind))].slice(0, limit);
  const waited = { count: 0 };
  const shots = [];
  for (let i = 0; i < shotRows.length; i += SHOTS_IN_FLIGHT) {
    await waitForLoad(waited, { oneMinuteLoad, pause });
    const batch = shotRows.slice(i, i + SHOTS_IN_FLIGHT);
    const results = await Promise.all(batch.map(async r => {
      const hex = r.id.slice(-16);
      const file = join(stateFolder, `${hex}.png`);
      return { id: r.id, name: `/library/inspiration/${r.kind}/${r.site.replace(/[^a-z0-9]+/g, '-')}-${hex}.png`, path: file, ok: await shoot(obscura, r.url, file) };
    }));
    shots.push(...results);
  }
  const shotIds = new Set(shots.filter(s => s.ok).map(s => s.id));
  writeFileSync(ledgerPath, JSON.stringify({ seen: [...ledger.seen, ...rows.map(r => r.canonical_url)] }));
  return {
    outcome: 'planned',
    counts: { ...counts, shots_ok: shotIds.size, shots_failed: shots.length - shotIds.size },
    statements: [...insertStatements(rows), ...shots.map(shotStatement)],
    shots: shots.map(s => ({ id: s.id, name: s.name, path: s.path, ok: s.ok })),
    waited: waited.count,
  };
}

// The BLAKE3 identity owner: 64 hex digits of the BLAKE3 of the text. The row id keeps the first 16.
export const blake3Hex = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text)).slice(3);

// The entry point the computer runs: one JSON object on stdin, one JSON line on stdout.
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  keepNewArcTabs(input, { blake3Hex }).then(out => process.stdout.write(`${JSON.stringify(out)}\n`), problem => {
    process.stdout.write(`${JSON.stringify({ outcome: 'error', why: problem.message })}\n`);
    process.exitCode = 1;
  });
}
