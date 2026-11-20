// The stays a person saves and lists in their own database, and the checks a stay must pass. A fake client stands in for the
// database; every name and place here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveStay, listMyStays, StayError } from '../do-work/stays-in-database.mjs';
import { stayDates, stayPrice, stayValues } from '../read-data/stays.mjs';

function fakeDatabase() {
  const rows = new Map();
  let clock = 0;
  return {
    rows,
    async query(text, values = []) {
      if (text.startsWith('CREATE TABLE')) return { rows: [] };
      if (text.startsWith('SELECT person, active FROM stays')) {
        const row = rows.get(values[0]);
        return { rows: row ? [{ person: row.person, active: row.active }] : [] };
      }
      if (text.startsWith('SELECT COUNT(*)')) {
        return { rows: [{ n: [...rows.values()].filter(row => row.person === values[0] && row.active === true).length }] };
      }
      if (text.startsWith('INSERT INTO stays')) {
        const [id, person, title, where_text, about, when_text, price_kind, amount_cents, currency, active] = values;
        const prior = rows.get(id);
        const row = { ...(prior ?? { id, person, created_at: clock }), title, where_text, about, when_text, price_kind, amount_cents, currency, active, updated_at: ++clock };
        rows.set(id, row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT * FROM stays WHERE person')) {
        return { rows: [...rows.values()].filter(row => row.person === values[0]).sort((a, b) => b.updated_at - a.updated_at).slice(0, values[1]) };
      }
      throw new Error(`unexpected SQL in the fake: ${text}`);
    },
  };
}

const offer = fields => ({ person: 'person:sample', title: 'A spare room', where: 'Lisbon', price: { kind: 'free' }, ...fields });

test('a stay keeps the checked text, the price and the active flag, and lists back with its person', async () => {
  const db = fakeDatabase();
  const { stay } = await saveStay(offer({ about: 'Quiet street', price: { kind: 'per-night', amount_cents: 9000, currency: 'usd' } }), db);
  assert.equal(stay.title, 'A spare room');
  assert.deepEqual(stay.price, { kind: 'per-night', amount_cents: 9000, currency: 'USD' });
  assert.equal(stay.active, true);
  const { stays } = await listMyStays({ person: 'person:sample' }, db);
  assert.equal(stays.length, 1);
  assert.equal(stays[0].stay_id, stay.stay_id);
});

test('a stay that is not the person\'s is refused, and nothing changes', async () => {
  const db = fakeDatabase();
  const { stay } = await saveStay(offer({ stay_id: 'stay_one' }), db);
  await assert.rejects(saveStay(offer({ person: 'person:other', stay_id: stay.stay_id, title: 'Changed' }), db), new StayError('This stay is not yours.'));
  assert.equal(db.rows.get('stay_one').title, 'A spare room');
});

test('a person cannot have more active stays than the per-host limit; an inactive one is still saved', async () => {
  const db = fakeDatabase();
  for (let n = 0; n < 6; n++) await saveStay(offer({ title: `Room ${n}` }), db);
  await assert.rejects(saveStay(offer({ title: 'Seventh' }), db), new StayError('You can show up to 6 stays.'));
  const { stay } = await saveStay(offer({ title: 'Seventh, paused', active: false }), db);
  assert.equal(stay.active, false);
});

test('a city, a price and a date are checked as the old network checked them', () => {
  assert.throws(() => stayValues(offer({ where: '' })), /A city or area is needed/);
  assert.throws(() => stayPrice({ kind: 'nightly' }), /Choose how this stay is priced/);
  assert.throws(() => stayPrice({ kind: 'per-night', amount_cents: 0 }), /valid nightly price/);
  assert.throws(() => stayPrice({ kind: 'per-night', amount_cents: 500, currency: 'us' }), /three-letter currency/);
  assert.deepEqual(stayDates('2099-06-01', '2099-06-04'), { start_date: '2099-06-01', end_date: '2099-06-04', nights: 3 });
  assert.throws(() => stayDates('2099-06-04', '2099-06-01'), /1 to 60 nights/);
  assert.throws(() => stayDates('2099-02-31', '2099-03-02'), /valid dates/);
});
