// tools/check-against-a-persons-rules-and-verdicts: a document split into pieces (do-work/pieces.mjs), and the row a
// person keeps for each. The atom tests are old trillion's test/method-sources.test.mjs, moved one to one; the rest
// are on made-up text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { atomsOf, pieceRow, pieceRows } from '../do-work/pieces.mjs';

const folder = resolve(import.meta.dirname, '..');

test('a file splits into pieces: paragraphs, list items and table rows under their headings, titles and table headers left out', () => {
  const atoms = atomsOf('# Title\n\nFirst paragraph here.\n\n## Part\n\n**Bold lead.** More words.\n\n1. One item\n   continued.\n2. Two item\n\n| Name | What |\n|---|---|\n| Row A | a |\n');
  assert.deepEqual(atoms.map(atom => atom.key), ['First paragraph here.', 'Part / Bold lead', 'Part / One item continued.', 'Part / Two item', 'Part / Row A']);
});

test('a fenced block is one piece, a rule line is none, and two pieces under one key are numbered', () => {
  const atoms = atomsOf('## Made-up\n\n```\nline one\n\nline two\n```\n\n---\n\nSame words.\n\nSame words.\n');
  assert.deepEqual(atoms.map(atom => atom.key), ['Made-up / line one line two', 'Made-up / Same words.', 'Made-up / Same words. (2)']);
  assert.equal(atoms[0].text, '```\nline one\n\nline two\n```');
});

test('an identity is 1f: and the BLAKE3 of the whitespace-folded text, so spacing alone changes nothing', () => {
  const [one] = atomsOf('Made-up   words\nhere.\n');
  const [two] = atomsOf('Made-up words here.\n');
  assert.match(one.identity, /^1f:[0-9a-f]{64}$/);
  assert.equal(one.identity, two.identity);
  assert.notEqual(atomsOf('Made-up words there.\n')[0].identity, one.identity);
});

test('a piece row carries its id, lead, text, identity, key and where it stands, with nothing checked yet', () => {
  const [atom] = atomsOf('## Made-up part\n\n**Made-up lead.** Then the rest.\n');
  const row = pieceRow(atom, { file: 'made-up.md', file_identity: '1f:' + 'a'.repeat(64), at: 1 });
  assert.deepEqual(row, {
    id: `piece-${atom.identity.slice(3, 27)}`, kind: 'piece', says: 'Made-up lead', text: '**Made-up lead.** Then the rest.', identity: atom.identity,
    key: 'Made-up part / Made-up lead', sources: [{ file: 'made-up.md', section: 'Made-up part / Made-up lead', file_identity: '1f:' + 'a'.repeat(64), at: 1 }],
    groups: [], kinds: [], checked_by: [],
  });
  assert.equal(row.id.length, 'piece-'.length + 24);
  assert.equal('no_check' in row, false);
});

test('two files holding the same text are one row with two sources, each with its own section, file identity and place', () => {
  const rows = pieceRows([
    { text: '## First\n\nShared made-up words.\n\nOnly in one.\n', file: 'one.md' },
    { text: 'Opening.\n\n## Second\n\nShared made-up words.\n', file: 'two.md', file_identity: '1f:' + 'b'.repeat(64) },
  ]);
  assert.deepEqual(rows.map(row => row.says), ['Shared made-up words.', 'Only in one.', 'Opening.']);
  const shared = rows[0];
  assert.deepEqual(shared.sources.map(source => [source.file, source.section, source.at]), [['one.md', 'First / Shared made-up words.', 1], ['two.md', 'Second / Shared made-up words.', 2]]);
  assert.match(shared.sources[0].file_identity, /^1f:[0-9a-f]{64}$/);
  assert.equal(shared.sources[1].file_identity, '1f:' + 'b'.repeat(64));
});

test('tool:split-a-document-into-pieces answers { pieces } on its last line and refuses a request with no text', () => {
  const run = input => spawnSync(process.execPath, ['do-work/split-a-document-into-pieces.mjs'], { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });
  const ran = run({ text: '## Made-up\n\n- one\n- two\n', file: 'made-up.md' });
  assert.equal(ran.status, 0, ran.stdout);
  const { pieces } = JSON.parse(ran.stdout.trim().split('\n').at(-1)).result;
  assert.deepEqual(pieces.map(piece => piece.key), ['Made-up / one', 'Made-up / two']);
  assert.equal(pieces[0].sources[0].file, 'made-up.md');
  const refused = run({ file: 'made-up.md' });
  assert.equal(refused.status, 1);
  assert.match(JSON.parse(refused.stdout.trim().split('\n').at(-1)).error, /Send text/);
});
