import assert from 'node:assert/strict';
import test from 'node:test';
import { wantedTargets } from '../do-work/wanted-targets.mjs';
import { readFileSync } from 'node:fs';
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/computers.json', import.meta.url), 'utf8'));
const { computers: COMPUTERS, table: TABLE, wanted: WANTED } = FIXTURE;

test('the targets to build are the ones the person\'s computers need, each once', () => {
  const answer = wantedTargets([...COMPUTERS, { id: 'second server', os: 'linux', arch: 'x86_64', libc: 'gnu' }], TABLE);
  assert.deepEqual(answer.targets, WANTED);
  assert.deepEqual(answer.answers.map(one => [one.computer, one.answer, one.targets]), [
    ['server', 'build', ['x86_64-unknown-linux-gnu']], ['pi', 'build', ['aarch64-unknown-linux-gnu']],
    ['laptop', 'build', ['aarch64-apple-darwin']], ['second server', 'build', ['x86_64-unknown-linux-gnu']],
  ]);
});

test('no computers want no targets, and a new computer adds exactly its own', () => {
  assert.deepEqual(wantedTargets([], TABLE), { targets: [], answers: [] });
  assert.deepEqual(wantedTargets([COMPUTERS[1]], TABLE).targets, ['aarch64-unknown-linux-gnu']);
});

test('a computer no row is for has no build: an answer with the plan, never an error', () => {
  const [answer] = wantedTargets([{ id: 'mainframe', os: 'linux', arch: 's390x', libc: 'gnu' }], TABLE).answers;
  assert.equal(answer.answer, 'no_build');
  assert.deepEqual(answer.blocked_by, []);
  assert.deepEqual(answer.plan.map(one => one.option), ['build_here', 'use_another_computers_artifact', 'run_as_module']);
  assert.deepEqual(answer.plan.find(one => one.option === 'run_as_module').targets, ['wasm32-unknown-unknown']);
});

test('a row that matches but does not build yet is named, and the module option is offered only when a module builds', () => {
  const [blocked] = wantedTargets([{ id: 'wasi box', os: 'wasi', arch: 'wasm32' }], TABLE).answers;
  assert.deepEqual([blocked.answer, blocked.blocked_by], ['no_build', ['wasm32-wasip2']]);
  const without = { targets: TABLE.targets.filter(row => row.capabilities.host !== 'module') };
  const [none] = wantedTargets([{ id: 'x', os: 'plan9', arch: 'mips' }], without).answers;
  assert.deepEqual(none.plan.map(one => one.option), ['build_here', 'use_another_computers_artifact']);
});

test('a computer that does not say its libc matches no libc-specific row', () => {
  assert.equal(wantedTargets([{ id: 'bare', os: 'linux', arch: 'x86_64' }], TABLE).answers[0].answer, 'no_build');
});
