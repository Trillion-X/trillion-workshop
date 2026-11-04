// A kept proposal is named by the AI its sign-in belongs to (src/ais.mjs withProposerNames), never by the sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiNameOfSignIn, withProposerNames } from '../src/ais.mjs';

const ais = [{ id: 'ai:claude-code', label: 'Claude Code', sign_ins: ['key:k1'] }, { id: 'ai:cursor', label: 'Cursor', sign_ins: ['key:k2', 'key:k3'] }, { id: 'ai:none', sign_ins: ['key:k9'] }];

test('a sign-in is named by the AI that answers to it, or by nothing', () => {
  assert.equal(aiNameOfSignIn(ais, 'key:k1'), 'Claude Code');
  assert.equal(aiNameOfSignIn(ais, 'key:k3'), 'Cursor');
  assert.equal(aiNameOfSignIn(ais, 'key:k9'), null, 'an AI with no name names nothing');
  assert.equal(aiNameOfSignIn(ais, 'key:unknown'), null);
  assert.equal(aiNameOfSignIn(ais, null), null);
});

test('one proposal and a page of them both carry proposer_name', () => {
  assert.equal(withProposerNames({ proposal_id: 'p1', by: 'key:k2' }, ais).proposer_name, 'Cursor');
  const page = withProposerNames({ proposals: [{ proposal_id: 'p1', by: 'key:k1' }, { proposal_id: 'p2', by: 'key:zz' }], next_cursor: 'c' }, ais);
  assert.deepEqual(page.proposals.map(row => row.proposer_name), ['Claude Code', null]);
  assert.equal(page.next_cursor, 'c');
  assert.equal(withProposerNames(null, ais), null);
});
