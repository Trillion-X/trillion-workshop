// tools/research-a-creator-or-topic/do-work/keep-new-arc-tabs-in-the-inspiration-library.mjs
//
// Runs on the person's computer. Reads the Arc sidebar file (a copy, so Arc is never written), plans the rows for tabs not
// yet in the library, takes screenshots of the design and site rows with Obscura (two at a time, only while the one-minute
// load is under the gate), and writes every shot that worked into one declared output file, out/shots.json. The rows are
// returned for the workflow to write through the SQL tool, so no database address is on this computer's command line or in
// this file.
//
//   stdin: { "held": [canonical addresses already in the library], "limit": N, "pending_shots": [{ id, url, kind, site }],
//            "obscura": "path to the Obscura binary", "sidebar": "path to StorableSidebar.json" }
//   writes: work/ (the sidebar copy and shot files, scratch) and out/shots.json ([{ id, name, png_base64 }])
//   stdout: one JSON line { outcome, counts, rows, shot_rows, waited }
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const WORK = 'work';
const SHOTS_FILE = join('out', 'shots.json');

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
  const { held = [], pending_shots: pendingShots, limit = rules.run_limits.shots_per_run, obscura, sidebar } = input;
  const pending_shots = pendingShots ?? [];
  if (!obscura || !sidebar) throw new Error('obscura and sidebar are required.');
  mkdirSync(WORK, { recursive: true });
  // Read a copy: Arc rewrites its own file while it runs.
  const copy = join(WORK, 'StorableSidebar.copy.json');
  copyFileSync(sidebar, copy);
  const { tabs } = readArcTabs(readFileSync(copy, 'utf8'));
  rmSync(copy);
  // Held addresses come in as the library stores them, so each one is put in canonical form before the comparison.
  const known = new Set(held.map(canonicalOrNull).filter(Boolean));
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
      const file = join(WORK, `${hex}.png`);
      const ok = await shoot(obscura, r.url, file);
      if (!ok) return { id: r.id, name: null, blake3: null, ok };
      const png = readFileSync(file);
      rmSync(file);
      // The shot's own identity: the BLAKE3 of its bytes, hex without the 1f: prefix, as screenshot_blake3 keeps it.
      const blake3 = makeHashCodeHexFromBytes(png).slice(3);
      return { id: r.id, name: `/library/inspiration/${r.kind}/${r.site.replace(/[^a-z0-9]+/g, '-')}-${hex}.png`, png_base64: png.toString('base64'), blake3, ok };
    }));
    shots.push(...results);
  }
  const shotsOk = shots.filter(s => s.ok);
  // The one declared output: every shot that worked, with its Files name. The keep step reads it from here.
  mkdirSync('out', { recursive: true });
  writeFileSync(SHOTS_FILE, JSON.stringify(shotsOk.map(({ id, name, png_base64 }) => ({ id, name, png_base64 }))));
  return {
    outcome: 'planned',
    counts: { ...counts, shots_ok: shotsOk.length, shots_failed: shots.length - shotsOk.length },
    // Rows for one parameterised insert; a row already in the library is left as it is.
    rows,
    // One update per shot: the file name and BLAKE3 of a shot that worked, and the state either way.
    shot_rows: shots.map(s => ({ id: s.id, name: s.ok ? s.name : null, blake3: s.blake3, state: s.ok ? 'none' : 'failed' })),
    waited: waited.count,
  };
}

// The BLAKE3 identity owner: 64 hex digits of the BLAKE3 of the text. The row id keeps the first 16.
export const blake3Hex = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text)).slice(3);

// The entry point the computer runs: one JSON object on stdin, one JSON line on stdout.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  keepNewArcTabs(input, { blake3Hex }).then(out => process.stdout.write(`${JSON.stringify(out)}\n`), problem => {
    process.stdout.write(`${JSON.stringify({ outcome: 'error', why: problem.message })}\n`);
    process.exitCode = 1;
  });
}
