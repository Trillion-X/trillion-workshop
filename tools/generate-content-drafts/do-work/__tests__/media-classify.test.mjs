/**
 * file: packages/content-production/do-work/__tests__/media-classify.test.mjs
 *
 * Tests for media.classify (plan §15 T06): rule-mode shape matching against
 * the live classify-rules.json DATA, manual pass-through, zero style names in
 * the classifier code, and the acceptance shapes (video+audio → first style;
 * audio-only → second style).
 */

import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'media-classify.mjs');

function classify(extra) {
  const stdout = execFileSync(process.execPath, [SCRIPT, '--rules', join(here, '../../test/fixtures/classify-rules.json'), ...extra], { encoding: 'utf8' });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

test('video+audio selects the talking-head definition (rule mode)', () => {
  const result = classify(['--shape', '{"video":true,"audio":true}']);
  assert.equal(result.definition, 'action:style-talking-head-aroll-slides');
  assert.equal(result.mode, 'rule');
});

test('audio-only selects the audio-slides definition (the T16 acceptance)', () => {
  const result = classify(['--shape', '{"video":false,"audio":true}']);
  assert.equal(result.definition, 'action:style-audio-slides-dominant');
  assert.equal(result.mode, 'rule');
});

test('manual mode passes the named definition through verbatim', () => {
  const result = classify(['--shape', '{}', '--mode', 'manual', '--definition', 'action:anything-at-all']);
  assert.equal(result.definition, 'action:anything-at-all');
  assert.equal(result.mode, 'manual');
});

test('no matching rule and no definitions list fails loudly (no silent default)', () => {
  assert.throws(() => classify(['--shape', '{"video":false,"audio":false}']));
});

test('the classifier code contains zero style names (rules carry them)', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.equal(source.includes('talking-head'), false);
  assert.equal(source.includes('audio-slides'), false);
});

test('adding a rule is one DATA row — a synthetic rules file changes selection with zero code', async () => {
  const { writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = tempFolder(join(tmpdir(), 'classify-'));
  const rulesFile = join(dir, 'rules.json');
  const liveExecution = JSON.parse(readFileSync(join(here, '../../test/fixtures/classify-rules.json'), 'utf8')).execution;
  writeFileSync(rulesFile, JSON.stringify({
    execution: liveExecution,
    rules: [{ when: { hologram: true }, definition: 'action:style-hologram' }],
    ai_mode: { argv: ['true'], prompt_template: '{shape} {definitions}' },
  }));
  const result = classify(['--shape', '{"hologram":true}', '--rules', rulesFile]);
  assert.equal(result.definition, 'action:style-hologram');
});
