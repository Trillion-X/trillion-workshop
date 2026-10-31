// Run the generic Python records:write builder inside a Workshop run. The wrapper keeps output in the run's private
// temporary folder and returns it as result JSON; its input roots and the records door are separate, scoped reads.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mountedRecordsDoor = '/opt/records-door/read-data/records-door.mjs';
const localRecordsDoor = resolve(here, '../../records-door/read-data/records-door.mjs');

function runPython(args) {
  return new Promise((resolveRun, rejectRun) => {
    const executable = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
    const child = spawn(executable, args, {
      env: { ...process.env, TRILLION_NODE: process.execPath },
      stdio: ['ignore', 'pipe', 'pipe', 3],
    });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => rejectRun(new Error(`Could not start Python for the records builder (${error.code ?? error.name}).`)));
    child.on('close', code => {
      const out = Buffer.concat(stdout).toString('utf8');
      const said = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) return rejectRun(new Error(said.slice(-600) || `The records builder exited ${code}.`));
      resolveRun(out);
    });
  });
}

/** Build with the run-scoped descriptor on fd 3. `input.roots` keeps the CLI's quoted `--root NAME=DIR` form. */
export async function buildRecordWrite(input) {
  if (!input || typeof input.mapping !== 'string' || !input.mapping) throw new Error('Give the mapping file path.');
  if (input.roots !== undefined && typeof input.roots !== 'string') throw new Error('Roots are text in the `--root NAME=DIR` form.');
  const outFolder = mkdtempSync(join(tmpdir(), 'records-write-build-'));
  const out = join(outFolder, 'payload.json');
  try {
    const recordsDoor = existsSync(mountedRecordsDoor) ? mountedRecordsDoor : localRecordsDoor;
    const args = [
      '-I', join(here, 'build_record_write.py'),
      '--mapping', input.mapping,
      '--out', out,
      '--records-door-module', recordsDoor,
    ];
    if (input.roots) args.push('--roots-text', input.roots);
    await runPython(args);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(outFolder, { recursive: true, force: true });
  }
}
