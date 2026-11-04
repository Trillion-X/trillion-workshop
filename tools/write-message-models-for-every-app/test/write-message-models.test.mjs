// The renderers moved from Trillion-X/trillion scripts/device-bridge-models.mjs. The old repository kept the
// TypeScript output it wrote (src/device-bridge-models.d.ts, copied to fixtures/models.d.ts): rendering the same rows
// here must give the same file, line for line after the header that names the generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputs, renderSwift, renderTypescript } from '../do-work/write-message-models.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'do-work', 'write-message-models.mjs');
const sample = join(here, '..', 'read-data', 'sample-models.json');
const spec = JSON.parse(readFileSync(sample, 'utf8'));
const body = text => text.split('\n').slice(1).join('\n');

test('the TypeScript declaration is the one the old generator wrote', () => {
  assert.equal(body(renderTypescript(spec)), body(readFileSync(join(here, 'fixtures', 'models.d.ts'), 'utf8')));
});

test('Swift takes each target\'s own names, protocols and Identifiable, and leaves out a model the target does not name', () => {
  const mac = renderSwift(spec, 'mac');
  assert.match(mac, /^\/\/ generated from .* never this file\nimport Foundation\n/);
  assert.match(mac, /struct Notice: Codable, Hashable, Identifiable \{/);
  assert.match(mac, /struct NoticeActionInput: Codable, Hashable \{/);
  assert.match(mac, /    var read: Bool\?\n/);
  assert.match(mac, /    let actions: \[NoticeAction\]\?\n/);
  assert.match(mac, /    let seq: Int\n/);
  const ios = renderSwift(spec, 'ios');
  assert.match(ios, /struct TrillionNoticeAction: Decodable, Equatable \{/);
  assert.match(ios, /    let input: TrillionNoticeActionInput\?\n/);
  assert.doesNotMatch(ios, /struct Notice\b/);
});

test('outputs answers one file per target', () => {
  assert.deepEqual(outputs(spec).map(item => item.file), [spec.targets.mac.file, spec.targets.ios.file, spec.targets.typescript.file]);
});

test('--write writes every target under --root, --check then passes, and a changed row makes --check fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'message-models-'));
  const models = join(root, 'models.json');
  writeFileSync(models, JSON.stringify(spec));
  assert.match(execFileSync('node', [script, '--models', models, '--root', root, '--write'], { encoding: 'utf8' }), /^Wrote /);
  assert.equal(readFileSync(join(root, spec.targets.typescript.file), 'utf8'), renderTypescript(spec).replace(/^\/\/ generated from [^ ]+/, `// generated from ${models}`));
  assert.equal(spawnSync('node', [script, '--models', models, '--root', root, '--check']).status, 0);
  assert.match(execFileSync('node', [script, '--models', models, '--root', root], { encoding: 'utf8' }), /Up to date/);
  const changed = structuredClone(spec);
  changed.models[2].fields.push({ name: 'pinned', type: 'Bool', optional: true });
  writeFileSync(models, JSON.stringify(changed));
  const check = spawnSync('node', [script, '--models', models, '--root', root, '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /Behind .*models\.json/);
});
