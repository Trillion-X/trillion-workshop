// A deal's price is one quote of its priced parts: one option per part, the total with every chosen part in it, and two
// views where the public view names only the parts it shows and never a hidden one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotePriceParts } from '../read-data/offer-price-parts.mjs';

// Fixture amounts for these tests only. None of them is a seller's price: a seller's amounts stay null until the seller sets them.
const part = (piece, option_key, label, basis, unit, amount_cents, shown_publicly, grant_purpose = null) =>
  ({ offer: 'offer:fixture', piece, option_key, label, basis, unit, amount_cents, shown_publicly, grant_purpose });
const parts = [
  part('format', 'in-person', 'In person', 'flat', null, 5000, true),
  part('format', 'online', 'Online', 'flat', null, 3000, true),
  part('format', 'both', 'Both', 'flat', null, 7000, true),
  part('length', 'per-hour', 'Per hour', 'per_unit', 'hour', 10000, true),
  part('length', 'per-week', 'Per week', 'per_unit', 'week', 300000, true),
  part('publicity', 'private', 'Private', 'flat', null, 0, false),
  part('publicity', 'public', 'Public', 'flat', null, 2500, false, 'publish'),
  part('testimonial', 'gives', 'Gives a testimonial', 'flat', null, 1000, false, 'publish'),
  part('testimonial', 'none', 'No testimonial', 'flat', null, 0, false),
];

test('online, 3 hours, public, gives a testimonial: the total holds the hidden parts, the public view names two', () => {
  const choices = {
    format: { option: 'online' },
    length: { option: 'per-hour', quantity: 3 },
    publicity: { option: 'public' },
    testimonial: { option: 'gives' },
  };
  const owner = quotePriceParts({ parts, choices });
  assert.equal(owner.total_cents, 3000 + 30000 + 2500 + 1000);
  assert.equal(owner.lines.length, 4);
  assert.deepEqual(owner.lines.find(line => line.piece === 'publicity'), {
    piece: 'publicity', option: 'public', label: 'Public', quantity: 1, unit: null, amount_cents: 2500,
    shown_publicly: false, grant_purpose: 'publish',
  });
  const publicView = quotePriceParts({ parts, choices, view: 'public' });
  assert.equal(publicView.total_cents, 36500);
  assert.deepEqual(publicView.lines.map(line => line.piece), ['format', 'length']);
  assert.deepEqual(publicView.lines[1], { piece: 'length', option: 'per-hour', label: 'Per hour', quantity: 3, unit: 'hour', amount_cents: 30000 });
});

test('in person, 1 week, private, no testimonial: a flat part at zero still counts as priced', () => {
  const choices = {
    format: { option: 'in-person' },
    length: { option: 'per-week', quantity: 1 },
    publicity: { option: 'private' },
    testimonial: { option: 'none' },
  };
  assert.equal(quotePriceParts({ parts, choices }).total_cents, 305000);
  const publicView = quotePriceParts({ parts, choices, view: 'public' });
  assert.equal(publicView.total_cents, 305000);
  assert.equal(publicView.lines.length, 2);
});

test('the public view never carries a hidden part, its label, its grant or its purpose', () => {
  const choices = {
    format: { option: 'both' },
    length: { option: 'per-hour', quantity: 2 },
    publicity: { option: 'public' },
    testimonial: { option: 'gives' },
  };
  const text = JSON.stringify(quotePriceParts({ parts, choices, view: 'public' }));
  assert.doesNotMatch(text, /publicity|testimonial|Public|Gives a testimonial|publish|grant_purpose|shown_publicly/);
});

test('an unpriced hidden part makes both totals null and the public view does not name it', () => {
  const unpricedParts = parts.map(row => row.piece === 'testimonial' && row.option_key === 'gives' ? { ...row, amount_cents: null } : row);
  const choices = { format: { option: 'online' }, length: { option: 'per-hour', quantity: 1 }, publicity: { option: 'private' }, testimonial: { option: 'gives' } };
  assert.equal(quotePriceParts({ parts: unpricedParts, choices }).total_cents, null);
  const publicView = quotePriceParts({ parts: unpricedParts, choices, view: 'public' });
  assert.equal(publicView.total_cents, null);
  assert.doesNotMatch(JSON.stringify(publicView), /testimonial|Gives a testimonial/);
});

test('an unpriced shown part is a null line, not a zero line', () => {
  const unpricedParts = parts.map(row => row.option_key === 'online' ? { ...row, amount_cents: null } : row);
  const choices = { format: { option: 'online' }, length: { option: 'per-hour', quantity: 1 }, publicity: { option: 'private' }, testimonial: { option: 'none' } };
  const publicView = quotePriceParts({ parts: unpricedParts, choices, view: 'public' });
  assert.equal(publicView.lines[0].amount_cents, null);
  assert.equal(publicView.total_cents, null);
});

test('a new piece kind needs no code: its row is priced by the same rule', () => {
  const withTravel = [...parts, part('travel', 'drive-in', 'Travel', 'flat', null, 4000, false)];
  const choices = { format: { option: 'online' }, length: { option: 'per-hour', quantity: 1 }, publicity: { option: 'private' }, testimonial: { option: 'none' }, travel: { option: 'drive-in' } };
  assert.equal(quotePriceParts({ parts: withTravel, choices }).total_cents, 3000 + 10000 + 0 + 0 + 4000);
  assert.equal(quotePriceParts({ parts: withTravel, choices, view: 'public' }).total_cents, 17000);
});

test('every part needs exactly one real option', () => {
  const full = { format: { option: 'online' }, length: { option: 'per-hour', quantity: 1 }, publicity: { option: 'private' }, testimonial: { option: 'none' } };
  assert.throws(() => quotePriceParts({ parts, choices: { ...full, format: undefined } }), /exactly one chosen option/);
  assert.throws(() => quotePriceParts({ parts, choices: { ...full, format: { option: 'by-post' } } }), /exactly one chosen option/);
  assert.throws(() => quotePriceParts({ parts, choices: { ...full, travel: { option: 'drive-in' } } }), /does not have/);
});

test('a per-unit part needs whole units and a flat part takes none', () => {
  const full = { format: { option: 'online' }, publicity: { option: 'private' }, testimonial: { option: 'none' } };
  assert.throws(() => quotePriceParts({ parts, choices: { ...full, length: { option: 'per-hour' } } }), /whole number of units/);
  assert.throws(() => quotePriceParts({ parts, choices: { ...full, length: { option: 'per-hour', quantity: 1.5 } } }), /whole number of units/);
  assert.throws(() => quotePriceParts({ parts, choices: { ...full, length: { option: 'per-hour', quantity: 1 }, format: { option: 'online', quantity: 2 } } }), /takes no quantity/);
});

test('only the owner or the public may ask for a quote', () => {
  assert.throws(() => quotePriceParts({ parts, choices: {}, view: 'staff' }), /owner or for the public/);
});
