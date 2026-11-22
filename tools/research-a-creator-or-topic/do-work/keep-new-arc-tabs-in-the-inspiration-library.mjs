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
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { promisify } from 'node:util';
import { readArcTabs, planIntake, canonicalUrl } from './arc-inspiration-intake.mjs';
import rules from './arc-inspiration-intake.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const run = promisify(execFile);
const GATE = rules.run_limits.load_gate_one_minute;
const SHOTS_IN_FLIGHT = rules.run_limits.shots_in_flight;
const SHOT_KINDS = new Set(['site', 'component', 'flow']);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function canonicalOrNull(url) {
  try { return canonicalUrl(url); } catch { return null; }
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
  // Held addresses come in as the library stores them, so each one is put in canonical form before the comparison.
  const known = new Set([...held.map(canonicalOrNull).filter(Boolean), ...ledger.seen]);
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
  // Planning does not write the ledger: a row is recorded as seen only after its database write, by recordSeen.
  return {
    outcome: 'planned',
    counts: { ...counts, shots_ok: shotIds.size, shots_failed: shots.length - shotIds.size },
    // Rows for one parameterised insert; a row already in the library is left as it is.
    rows,
    // One update per shot: the file name of a shot that worked, and the state either way.
    shot_rows: shots.map(s => ({ id: s.id, name: s.ok ? s.name : null, state: s.ok ? 'none' : 'failed' })),
    // The files to keep in Files, in order; the kept names come back from the keep step.
    keep_files: shots.filter(s => s.ok).map(s => ({ path: s.path, name: s.name, media_type: 'image/png' })),
    waited: waited.count,
  };
}

// Adds the addresses of rows the database has taken to the ledger, so the next plan does not offer them again. Called
// after the insert, with the rows the insert used; a row the insert did not take is simply planned again later.
export function recordSeen({ state_folder: stateFolder, record }) {
  if (!stateFolder || !Array.isArray(record)) throw new Error('state_folder and record (the rows) are required.');
  mkdirSync(stateFolder, { recursive: true });
  const ledgerPath = join(stateFolder, 'ledger.json');
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { seen: [] };
  const seen = new Set(ledger.seen);
  for (const row of record) seen.add(row.canonical_url);
  writeFileSync(ledgerPath, JSON.stringify({ seen: [...seen] }));
  return { outcome: 'recorded', recorded: record.length, ledger: seen.size };
}

// The BLAKE3 identity owner: 64 hex digits of the BLAKE3 of the text. The row id keeps the first 16.
export const blake3Hex = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text)).slice(3);

// The entry point the computer runs: one JSON object on stdin, one JSON line on stdout. An input with record set is the
// ledger step (recordSeen); any other input plans the rows and takes the shots (keepNewArcTabs).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const run = input.record ? Promise.resolve().then(() => recordSeen(input)) : keepNewArcTabs(input, { blake3Hex });
  run.then(out => process.stdout.write(`${JSON.stringify(out)}\n`), problem => {
    process.stdout.write(`${JSON.stringify({ outcome: 'error', why: problem.message })}\n`);
    process.exitCode = 1;
  });
}
