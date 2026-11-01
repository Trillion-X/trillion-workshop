import { text } from 'node:stream/consumers';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectAndRefresh } from '../read-data/collect.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
const statePath = input.state_path;
const outputPath = input.output_path;
let prior = input.prior ?? null;
if (!prior && statePath) {
  try { prior = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const result = await collectAndRefresh({ ...input, prior });
const payload = JSON.stringify(result, null, 2) + '\n';
async function atomicWrite(target, data) {
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, target);
}
if (statePath) await atomicWrite(statePath, JSON.stringify(result.refresh_state, null, 2) + '\n');
if (outputPath) await atomicWrite(outputPath, payload);
process.stdout.write(payload);
