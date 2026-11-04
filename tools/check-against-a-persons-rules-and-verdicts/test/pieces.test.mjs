// tools/check-against-a-persons-rules-and-verdicts: a document split into pieces (do-work/pieces.mjs, whose atomsOf is
// read from tools/documents-as-list-rows), and the row a person keeps for each. The first test is old trillion's
// test/method-sources.test.mjs:46, moved one to one; the rest are on made-up text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomsOf, keepPieces, pieceRow, pieceRows } from '../do-work/pieces.mjs';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

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
  const row = pieceRow(atom, { file: 'made-up.md', file_identity: '1f:' + 'a'.repeat(64) });
  assert.deepEqual(row, {
    id: `piece-${atom.identity.slice(3, 27)}`, kind: 'piece', says: 'Made-up lead', text: '**Made-up lead.** Then the rest.', identity: atom.identity,
    key: 'Made-up part / Made-up lead', sources: [{ file: 'made-up.md', section: 'Made-up part / Made-up lead', file_identity: '1f:' + 'a'.repeat(64), at: 3 }],
    tags: [], kinds: [], checked_by: [],
  });
  assert.equal(row.id.length, 'piece-'.length + 24);
  assert.equal('no_check' in row, false);
});

test('two files holding the same text are one row with two sources, each with its own section, file identity and line', () => {
  const rows = pieceRows([
    { text: '## First\n\nShared made-up words.\n\nOnly in one.\n', file: 'one.md' },
    { text: 'Opening.\n\n## Second\n\nShared made-up words.\n', file: 'two.md', file_identity: '1f:' + 'b'.repeat(64) },
  ]);
  assert.deepEqual(rows.map(row => row.says), ['Shared made-up words.', 'Only in one.', 'Opening.']);
  const shared = rows[0];
  assert.deepEqual(shared.sources.map(source => [source.file, source.section, source.at]), [['one.md', 'First / Shared made-up words.', 3], ['two.md', 'Second / Shared made-up words.', 5]]);
  assert.match(shared.sources[0].file_identity, /^1f:[0-9a-f]{64}$/);
  assert.equal(shared.sources[1].file_identity, '1f:' + 'b'.repeat(64));
});

test('~~~ fences a block as ``` does, as CommonMark defines a fence: the same character, at least as many, nothing after', () => {
  const keys = text => atomsOf(text).map(atom => atom.text);
  assert.deepEqual(keys('## Made-up\n\n~~~\nline one\n\nline two\n~~~\n\nAfter.\n'), ['~~~\nline one\n\nline two\n~~~', 'After.']);
  // A fence of one character is not closed by the other, nor by fewer of its own, nor by a line with words after it.
  assert.deepEqual(keys('~~~\n```\n\nstill fenced\n~~~\n'), ['~~~\n```\n\nstill fenced\n~~~']);
  assert.deepEqual(keys('````md\n```\n\ninside\n```\n````\n\nOut.\n'), ['````md\n```\n\ninside\n```\n````', 'Out.']);
  assert.deepEqual(keys('~~~~\n~~~\n\nstill\n~~~~ \n'), ['~~~~\n~~~\n\nstill\n~~~~']);
  assert.deepEqual(keys('```\ncode\n```js\n\nmore\n```\n'), ['```\ncode\n```js\n\nmore\n```']);
  // A tilde fence's info string may hold backticks; a backtick fence's may not, so that line is words.
  assert.deepEqual(keys('~~~ made`up\nx\n\ny\n~~~\n'), ['~~~ made`up\nx\n\ny\n~~~']);
  assert.deepEqual(keys('``` made`up ```\n\nNext.\n'), ['``` made`up ```', 'Next.']);
  // Two tildes fence nothing, and a fence left open runs to the end of the document.
  assert.deepEqual(keys('~~\n\nwords\n'), ['~~', 'words']);
  assert.deepEqual(keys('Before.\n\n~~~\nopen\n\nto the end\n'), ['Before.', '~~~\nopen\n\nto the end']);
  // Inside a list item a fence is indented by its item, and still fences.
  assert.deepEqual(keys('1. Run:\n   ~~~sh\n   made-up\n\n   more\n   ~~~\n2. Next\n'), ['1. Run:', '~~~sh\n   made-up\n\n   more\n   ~~~', '2. Next']);
});

test('tool:split-a-document-into-pieces keeps the pieces of its text as piece rows and answers counts; a request with neither text nor name is refused', async () => {
  const row = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload).find(item => item.id === 'tool:split-a-document-into-pieces');
  const ran = await runRow(row, { text: '## Made-up\n\n- one\n- two\n', file: 'made-up.md' }, { records: [] });
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  const answer = ran.last.result;
  assert.deepEqual([answer.file, answer.pieces, answer.new, answer.sources_added, answer.unchanged, answer.writes], ['made-up.md', 2, 2, 0, 0, 1]);
  const kept = ran.kept.map(record => record.value);
  assert.deepEqual(kept.map(piece => piece.key).sort(), ['Made-up / one', 'Made-up / two']);
  assert.deepEqual(answer.ids, kept.map(piece => piece.id).sort((a, b) => answer.ids.indexOf(a) - answer.ids.indexOf(b)));
  assert.equal(kept[0].sources[0].file, 'made-up.md');
  for (const input of [{ file: 'made-up.md' }, { text: 'x', name: '/Notes/x.md' }]) {
    const refused = await runRow(row, input, { records: [] });
    assert.equal(refused.code, 1);
    assert.match(refused.last.error, /Send text/);
  }
});

test('a piece kept before pieces carried tags has its groups moved to tags when it is kept again, its words left alone', async () => {
  const text = '## Made-up\n\nMade-up kept words.\n';
  const [row] = pieceRows([{ text, file: 'made-up.md', file_identity: '1f:' + 'f'.repeat(64) }]);
  const { tags, ...old } = row;
  const held = new Map([[`record:check:${row.id}`, { ...old, groups: ['made-up-tag'], checked_by: ['made-up-check'] }]]);
  const written = [];
  const door = { async read(_type, id) { return held.get(id) ?? null; }, async write(batch) { written.push(...batch); } };
  const answer = await keepPieces({ text, file: 'made-up.md', file_identity: '1f:' + 'f'.repeat(64) }, door);
  assert.equal(answer.unchanged, 0);
  assert.equal(written.length, 1);
  const value = written[0].value;
  assert.equal('groups' in value, false);
  assert.deepEqual(value.tags, ['made-up-tag']);
  assert.deepEqual(value.checked_by, ['made-up-check']);
  assert.deepEqual(written[0].expected.value.groups, ['made-up-tag'], 'the write is conditional on the row as it was read');
  held.set(`record:check:${row.id}`, value);
  written.length = 0;
  const again = await keepPieces({ text, file: 'made-up.md', file_identity: '1f:' + 'f'.repeat(64) }, door);
  assert.deepEqual([again.unchanged, written.length], [1, 0]);
});
