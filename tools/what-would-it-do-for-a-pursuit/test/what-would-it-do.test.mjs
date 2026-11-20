// What the platform would do for a pursuit, kept for one day in the person's database. A fake client stands in for it; the
// vectors, rows and recordings are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whatWouldItDo } from '../do-work/what-would-it-do.mjs';
import { pursuitAnswerKey } from '../read-data/pursuit-answer-key.mjs';

const table = {
  dimensions: 2,
  rows: ['row:sales-page'],
  vectors: new Float64Array([1, 0]),
  moves: [{ id: 'sell', label: 'Sell it', vector: [1, 0], rows: [{ id: 'row:sales-page', closeness: 0.9 }] }],
};
const base = { pursuit: '  sell a mobile game  ', person: 'person:sample', pursuit_vector: [1, 0.1], moves: table, rows: [{ id: 'row:sales-page', kind: 'workflow', label: 'Write a sales page' }], recordings: [] };

function fakeDatabase() {
  const rows = new Map();
  return {
    rows,
    async query(text, values = []) {
      if (text.startsWith('CREATE TABLE')) return { rows: [] };
      if (text.startsWith('SELECT answer FROM pursuit_answers')) {
        const row = rows.get(values[0]);
        return { rows: row && row.expires_at > values[1] ? [{ answer: row.answer }] : [] };
      }
      if (text.startsWith('INSERT INTO pursuit_answers')) {
        rows.set(values[0], { person: values[1], pursuit: values[2], answer: JSON.parse(values[3]), expires_at: values[5] });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL in the fake: ${text}`);
    },
  };
}

test('the answer picks the closest move row, and a second ask gets the kept answer for one day', async () => {
  const db = fakeDatabase();
  const first = await whatWouldItDo(base, db);
  assert.equal(first.first_moves[0].row.id, 'row:sales-page');
  assert.equal(first.kept, false);
  const second = await whatWouldItDo(base, db);
  assert.equal(second.kept, true);
  assert.equal(second.first_moves[0].row.id, 'row:sales-page');
});

test('an expired kept answer is answered afresh', async () => {
  const db = fakeDatabase();
  await whatWouldItDo(base, db, { now: () => new Date('2099-01-01T00:00:00Z') });
  const later = await whatWouldItDo(base, db, { now: () => new Date('2099-01-03T00:00:00Z') });
  assert.equal(later.kept, false);
});

test('without a person nothing is kept, and a new recording gives a new key', async () => {
  const db = fakeDatabase();
  const answer = await whatWouldItDo({ ...base, person: undefined }, db);
  assert.equal(answer.kept, false);
  assert.equal(db.rows.size, 0);
  assert.notEqual(pursuitAnswerKey('a mobile game', []), pursuitAnswerKey('a mobile game', [{ id: 'r1', video: 'v' }]));
});
