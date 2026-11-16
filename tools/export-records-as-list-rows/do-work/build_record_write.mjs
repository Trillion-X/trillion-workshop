// Run the generic Python records:write builder inside a Workshop run. The wrapper keeps output in the run's private
// temporary folder and returns it as result JSON; it reads no account: the records its mapping reads (lists_read and records
// sources) come in as `input.records`, read from a store by the caller's AI.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
function runPython(args) {
  return new Promise((resolveRun, rejectRun) => {
    // `python3` from the computer's own path, on every computer; the tool never asks what kind of machine it runs on.
    const child = spawn('python3', args, {
      env: { ...process.env, TRILLION_NODE: process.execPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => rejectRun(new Error(error.code === 'ENOENT'
      ? 'This computer has no python3 on its path; give the run Python 3.10 or newer as python3 to build records.'
      : `Could not start Python for the records builder (${error.code ?? error.name}).`)));
    child.on('close', code => {
      const out = Buffer.concat(stdout).toString('utf8');
      const said = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) return rejectRun(new Error(said.slice(-600) || `The records builder exited ${code}.`));
      resolveRun(out);
    });
  });
}

/** Build from the mapping, and the records handed in as `input.records` (a list of { id, type, value }). `input.roots` keeps the CLI's quoted `--root NAME=DIR` form. */
export async function buildRecordWrite(input) {
  if (!input || typeof input.mapping !== 'string' || !input.mapping) throw new Error('Give the mapping file path.');
  if (input.roots !== undefined && typeof input.roots !== 'string') throw new Error('Roots are text in the `--root NAME=DIR` form.');
  if (input.records !== undefined && (!Array.isArray(input.records) || !input.records.every(record => record && typeof record === 'object' && typeof record.id === 'string' && typeof record.type === 'string'))) throw new Error('records are the records the mapping reads, as [{ id, type, value }] read from the person\'s records.');
  const outFolder = mkdtempSync(join(tmpdir(), 'records-write-build-'));
  const out = join(outFolder, 'payload.json');
  try {
    const args = [
      '-I', join(here, 'build_record_write.py'),
      '--mapping', input.mapping,
      '--out', out,
    ];
    if (input.roots) args.push('--roots-text', input.roots);
    if (input.records !== undefined) {
      const held = join(outFolder, 'records.json');
      writeFileSync(held, JSON.stringify({ records: input.records }), { mode: 0o600 });
      args.push('--records-from', held);
    }
    await runPython(args);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(outFolder, { recursive: true, force: true });
  }
}
