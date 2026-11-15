// Optional original-caller evidence needs caller-supplied source files; ordinary source tests do not invent them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonForTests } from '../test-helpers/python-environment.mjs';

const originalInputs = Boolean(process.env.WRITING_LEGACY_BENCHMARK && process.env.WRITING_DECIDER_SOURCE);
test('the maintained profiler preserves the original caller through the verified reference profile', {
  skip: originalInputs ? false : 'requires caller-supplied original benchmark and reference source',
  timeout: 900000,
}, () => {
  const result = spawnSync(pythonForTests('classifier-reference'), ['-I', '-B',
    fileURLToPath(new URL('../tools/answer-questions-about-many-states/test/test_benchmark_profile.py', import.meta.url))], {
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', OMP_NUM_THREADS: '1' },
    encoding: 'utf8', maxBuffer: 8 * 1024 ** 2, timeout: 840000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, result.error?.message ?? output);
  assert.match(output, /Ran 6 tests\b/);
  assert.match(output, /\nOK\s*$/);
  assert.doesNotMatch(output, /skipped=/);
  assert.match(result.stdout, /"numerical_qualification": false/);
  console.log(JSON.stringify({ profile: 'classifier-reference', python_tests: 6, skipped: 0,
    device: process.env.WRITING_PROFILE_DEVICE ?? 'cpu', numerical_qualification: false }));
});
