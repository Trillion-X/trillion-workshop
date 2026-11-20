// A reader's record kind comes from read-data/meaning-search.json (`kinds`), never from a literal in code.
// Proof: rename the kinds in a copy of the package, feed the prepare reader rows under the new names (accepted),
// and the old literal names (refused); and the two readers hold no kind literal.
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const tool = join(here, '..', '..');
const KIND_LITERALS = ['semantic-index-descriptor', 'capability-index-source-descriptor', 'discovery-readiness-policy', 'semantic-index-convergence'];

function copyPackage(renamed) {
  // The same relative layout as the Workshop: process-scripts imports ../../read-data and the content-identity tool.
  const root = tempFolder(join(tmpdir(), 'kinds-data-'));
  const tools = join(root, 'tools');
  const copy = join(tools, 'search-everything-with-one-question', 'meaning');
  mkdirSync(copy, { recursive: true });
  cpSync(join(pkg, 'do-work'), join(copy, 'do-work'), { recursive: true });
  cpSync(join(pkg, 'read-data'), join(copy, 'read-data'), { recursive: true });
  cpSync(join(tool, '..', 'content-identity'), join(tools, 'content-identity'), { recursive: true });
  symlinkSync(join(tool, '..', '..', 'node_modules'), join(root, 'node_modules'));
  const settingsPath = join(copy, 'read-data', 'meaning-search.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  for (const [key, value] of Object.entries(settings.kinds)) settings.kinds[key] = renamed(value);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { root, script: join(copy, 'do-work', 'process-scripts', 'prepare-semantic-index-process-input.mjs') };
}

function runPrepare(script, root, kind) {
  const reply = { items: [{ payload: { kind, index_id: 'idx', ann_params: { seed: 1 } } }] };
  const ann = { items: [] };
  const write = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const args = ['--index-id', 'idx', '--descriptor-reply-json', write('d.json', reply), '--ann-state-reply-json', write('a.json', ann),
    '--output-state-json', join(root, 'state.json'), '--output-json', join(root, 'out.json')];
  try { execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' }); return { ok: true, out: JSON.parse(readFileSync(join(root, 'out.json'), 'utf-8')) }; }
  catch (error) { return { ok: false, stderr: String(error.stderr) }; }
}

test('the prepare reader finds its descriptor under a renamed kind from DATA, and refuses the old literal', () => {
  const { root, script } = copyPackage(value => `renamed-${value}`);
  const renamed = runPrepare(script, root, 'renamed-semantic-index-descriptor');
  assert.equal(renamed.ok, true, renamed.stderr);
  assert.equal(renamed.out.descriptor.index_id, 'idx');
  const literal = runPrepare(script, root, 'semantic-index-descriptor');
  assert.equal(literal.ok, false);
  assert.match(literal.stderr, /exactly one current row/);
});

test('the readiness and prepare readers hold no record kind literal', () => {
  for (const file of ['assert-semantic-index-readiness.mjs', 'prepare-semantic-index-process-input.mjs']) {
    const source = readFileSync(join(pkg, 'do-work', 'process-scripts', file), 'utf-8');
    for (const literal of KIND_LITERALS) assert.equal(source.includes(`"${literal}"`), false, `${file} names ${literal}`);
  }
});
