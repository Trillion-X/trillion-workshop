// The person's own recording rules, facts, rights and private mode, kept in their files and honoured by the listener's decision (computer/listening-rules.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rowOf } from '../listen.mjs';
import { factsIn, filesOf, privateModeIn, rulesIn } from '../listening-rules.mjs';
import { available } from '../../listen-for-a-while/read-data/private-mode.mjs';
import { evaluate } from '../../listen-for-a-while/read-data/recording-rules.mjs';

const shipped = rowOf(JSON.parse(readFileSync(new URL(import.meta.resolve('../../bring-in-new-items-from-this-computer/computer/computer-sources.json')), 'utf8'))).listen;
const mine = () => ({ ...shipped, state: mkdtempSync(path.join(os.tmpdir(), 'rules-')) });
const verdict = listen => evaluate(rulesIn(listen), factsIn(listen, 'mac'));
const keep = (listen, name, value) => writeFileSync(filesOf(listen)[name], JSON.stringify(value));

test('with nothing kept the listener is open; a kept require rule waits for its fact, and the fact decides', () => {
  const listen = mine();
  assert.equal(verdict(listen).state, 'allowed');
  keep(listen, 'rules', { rows: [{ id: 'notice-first', effect: 'require', when: { kind: 'listening' }, facts: ['notice_given'] }] });
  assert.deepEqual([verdict(listen).state, verdict(listen).by], ['pending', ['notice-first']]);
  keep(listen, 'facts', { notice_given: false });
  assert.equal(verdict(listen).state, 'blocked');
  keep(listen, 'facts', { notice_given: true });
  assert.equal(verdict(listen).state, 'allowed');
});

test('a kept block rule blocks; a file that cannot be read is treated as empty', () => {
  const listen = mine();
  keep(listen, 'rules', { rows: [{ id: 'no-evenings', effect: 'block', when: { kind: 'listening' }, says: 'no listening in the evening' }] });
  assert.equal(verdict(listen).state, 'blocked');
  writeFileSync(filesOf(listen).rules, 'not json');
  assert.deepEqual(rulesIn(listen), [...(listen.recording_rules ?? [])]);
});

test('a kept grant for the person is the granted fact a require-granted rule sees', () => {
  const listen = mine();
  keep(listen, 'rules', { rows: [{ id: 'host-ok', effect: 'require', when: { kind: 'listening' }, facts: ['granted'] }] });
  assert.equal(verdict(listen).state, 'pending');
  keep(listen, 'grants', { granted: [{ person: listen.grant_person ?? 'me', scope: 'persistent', by: 'ana' }] });
  assert.equal(verdict(listen).state, 'allowed');
});

test('private mode kept by the person overrides the shipped value and takes sound off in the owner', () => {
  const listen = mine();
  assert.equal(available(privateModeIn(listen), 'sound'), true);
  keep(listen, 'private', { on: true });
  assert.equal(privateModeIn(listen).on, true);
  assert.equal(available(privateModeIn(listen), 'sound'), false);
  assert.equal(available(privateModeIn(listen), 'notes'), true);
});
