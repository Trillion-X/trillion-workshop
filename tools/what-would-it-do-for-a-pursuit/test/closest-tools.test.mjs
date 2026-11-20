// What the platform would do for a pursuit: the words check and the closest-tools ranking. Vectors are made up and small.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pursuitWords, answerFromMoves } from '../read-data/closest-tools.mjs';

test('the pursuit words are checked to 3 to 300 characters, trimmed', () => {
  assert.equal(pursuitWords('  a mobile game  '), 'a mobile game');
  assert.throws(() => pursuitWords('ab'), /3 to 300 characters/);
  assert.throws(() => pursuitWords('x'.repeat(301)), /3 to 300 characters/);
  assert.throws(() => pursuitWords(undefined), /3 to 300 characters/);
});

test('a pursuit gets the move it is close to, and the row at the top of that move, with its recording', () => {
  const rows = [
    { id: 'row:sales-page', kind: 'workflow', label: 'Write a sales page' },
    { id: 'row:video-tool', kind: 'tool', label: 'Make a video' },
    { id: 'row:demo', kind: 'recording', label: 'A demo screen' },
  ];
  const rowsById = new Map(rows.map(row => [row.id, row]));
  const table = {
    dimensions: 2,
    rows: ['row:sales-page', 'row:video-tool', 'row:demo'],
    vectors: new Float64Array([1, 0, 0, 1, 0.5, 0.5]),
    moves: [
      { id: 'sell', label: 'Sell it', vector: [1, 0], rows: [{ id: 'row:sales-page', closeness: 0.9 }] },
      { id: 'show', label: 'Show people', vector: [0, 1], rows: [{ id: 'row:video-tool', closeness: 0.8 }] },
    ],
  };
  const list = [{ id: 'recording:demo', shows: ['row:video-tool'], video: 'https://example.test/video.mp4' }];
  const answer = answerFromMoves(table, [1, 0.1], rowsById, list);
  assert.equal(answer.first_moves[0].id, 'sell');
  assert.equal(answer.first_moves[0].row.id, 'row:sales-page');
  assert.equal(answer.workflows.length, 0);
  const shown = answerFromMoves(table, [0.2, 1], rowsById, list);
  assert.equal(shown.first_moves[0].row.id, 'row:video-tool');
  assert.deepEqual(shown.first_moves[0].row.recording, list[0]);
});

test('a pursuit close to no move gets no first move at all', () => {
  const rowsById = new Map([['row:a', { id: 'row:a', kind: 'tool' }]]);
  const table = { dimensions: 2, rows: ['row:a'], vectors: new Float64Array([1, 0]), moves: [{ id: 'show', vector: [0, 1], rows: [{ id: 'row:a', closeness: 0.9 }] }] };
  const answer = answerFromMoves(table, [0.01, 0.01], rowsById);
  assert.deepEqual(answer.first_moves, []);
});
