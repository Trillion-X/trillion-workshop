import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublishedContentSource } from '../src/published-content-source.mjs';
import { readPublishedPriceRules, PRICE_RULES_SOURCE } from '../src/published-price-rules.mjs';

const SOURCE = { file: 'records/service-price-rules.json', pointer: '/rules' };
const ID = 'source:["records/service-price-rules.json","/rules"]';
const MAKER = 'maker:owner';
const SHELF = 'shelf:test';
const itemIdOf = (maker, id) => `item:${maker}:${id}`;
const identityOf = value => `id:${JSON.stringify(value)}`;
const check = value => {
  if (value === undefined) throw new Error('no value');
  return value;
};
const publishedRow = (value, overrides = {}) => ({
  id: itemIdOf(MAKER, ID), format: 'json', revision: 3, value, value_identity: identityOf(value), ...overrides,
});
const ports = (state, { makers = [MAKER], seen = [] } = {}) => ({
  shelf: SHELF,
  makers,
  read: async input => { seen.push(input); return typeof state === 'function' ? state() : state; },
  check,
  identityOf,
  itemIdOf,
});
const BOOT = [{ applies_to: 'experiment:a', rule: { mode: 'controller' } }];
const UNIT_RULE = { mode: 'controller', start_cents: 10000, floor_cents: 5000, sales_to_double: 1, target_win_rate: 0.05, currency: 'usd', interval: 'month' };
const code = (error, expected) => error.code === expected;

test('no makers means the shipped value is the answer and nothing is read', async () => {
  const seen = [];
  const out = await resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports({ item: null, adopted: false }, { makers: [], seen }) });
  assert.deepEqual(out, { id: ID, from: 'bootstrap', found: true, value: BOOT });
  assert.equal(seen.length, 0);
});

test('a published row replaces the shipped value and carries its revision', async () => {
  const published = [{ applies_to: 'experiment:b', rule: UNIT_RULE }];
  const seen = [];
  const out = await resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports({ item: { maker: MAKER, row: publishedRow(published) }, adopted: true }, { seen }) });
  assert.deepEqual(out, { id: ID, from: 'published', found: true, revision: 3, value: published });
  assert.deepEqual(seen, [{ shelf: SHELF, id: ID, makers: [MAKER] }]);
});

test('a published JSON null is a published value, not a withdrawal', async () => {
  const out = await resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports({ item: { maker: MAKER, row: publishedRow(null) }, adopted: true }) });
  assert.deepEqual(out, { id: ID, from: 'published', found: true, revision: 3, value: null });
});

test('an adopted section with no live item is withdrawn and yields nothing, not the shipped value', async () => {
  const out = await resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports({ item: null, adopted: true }) });
  assert.deepEqual(out, { id: ID, from: 'withdrawn', found: false });
});

test('a section never published uses the shipped value', async () => {
  const out = await resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports({ item: null, adopted: false }) });
  assert.deepEqual(out, { id: ID, from: 'bootstrap', found: true, value: BOOT });
});

test('an item from a maker outside the list does not count', async () => {
  const foreign = { item: { maker: 'maker:stranger', row: publishedRow(BOOT, { id: itemIdOf('maker:stranger', ID) }) }, adopted: false };
  const out = await resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports(foreign) });
  assert.deepEqual(out, { id: ID, from: 'bootstrap', found: true, value: BOOT });
});

test('malformed publication evidence is refused as unavailable', async () => {
  for (const state of [{ item: null }, { item: null, adopted: 'yes' }, { item: 'x', adopted: false }, null]) {
    await assert.rejects(
      resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports(state) }),
      error => code(error, 'marketplace_content_source_unavailable'),
    );
  }
});

test('a row with the wrong item id, format, revision or value is refused', async () => {
  const bad = [
    publishedRow(BOOT, { id: 'item:other' }),
    publishedRow(BOOT, { logical_id: 'source:["x","/y"]' }),
    publishedRow(BOOT, { format: 'text' }),
    publishedRow(BOOT, { revision: 0 }),
    publishedRow(BOOT, { revision: 1.5 }),
    { id: itemIdOf(MAKER, ID), format: 'json', revision: 3 },
  ];
  for (const row of bad) {
    await assert.rejects(
      resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports({ item: { maker: MAKER, row }, adopted: true }) }),
      error => code(error, 'marketplace_content_source_unavailable'),
    );
  }
});

test('a row that names another source coordinate is refused, and a row with the same coordinate passes', async () => {
  await assert.rejects(
    resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports({ item: { maker: MAKER, row: publishedRow(BOOT, { source: { file: 'records/other.json', pointer: '/rules' } }) }, adopted: true }) }),
    error => code(error, 'marketplace_content_source_unavailable'),
  );
  const same = await resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports({ item: { maker: MAKER, row: publishedRow(BOOT, { source: SOURCE }) }, adopted: true }) });
  assert.equal(same.from, 'published');
});

test('a value that differs from its published identity is refused', async () => {
  const row = publishedRow(BOOT, { value_identity: 'id:tampered' });
  await assert.rejects(
    resolvePublishedContentSource(SOURCE, { bootstrap: BOOT, ...ports({ item: { maker: MAKER, row }, adopted: true }) }),
    error => code(error, 'marketplace_content_source_unavailable'),
  );
});

test('the price list reads the published rules in place of the shipped ones', async () => {
  const published = [{ applies_to: '  experiment:example-plan ', rule: UNIT_RULE }];
  const rules = await readPublishedPriceRules({ bootstrap: BOOT, ...ports({ item: { maker: MAKER, row: publishedRow(published) }, adopted: true }) });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].applies_to, 'experiment:example-plan');
  assert.equal(rules[0].rule.mode, 'controller');
  assert.equal(rules[0].rule.start_cents, 10000);
  assert.equal(rules[0].rule.floor_cents, 5000);
});

test('the price list reads the shipped rules, cleaned, when nothing is published', async () => {
  const shipped = [{ applies_to: 'experiment:example-plan', rule: UNIT_RULE }];
  const rules = await readPublishedPriceRules({ bootstrap: shipped, ...ports({ item: null, adopted: false }) });
  assert.equal(rules[0].applies_to, 'experiment:example-plan');
  assert.equal(rules[0].rule.unit_cents, 100, 'the engine defaults fill the rule');
});

test('a withdrawn price list is the empty list', async () => {
  assert.deepEqual(await readPublishedPriceRules({ bootstrap: BOOT, ...ports({ item: null, adopted: true }) }), []);
});

test('a price list with a duplicate, blank or non-object row is refused', async () => {
  const lists = [
    [{ applies_to: 'experiment:a', rule: UNIT_RULE }, { applies_to: ' experiment:a ', rule: UNIT_RULE }],
    [{ applies_to: '   ', rule: UNIT_RULE }],
    ['experiment:a'],
  ];
  for (const list of lists) {
    await assert.rejects(
      readPublishedPriceRules({ bootstrap: BOOT, ...ports({ item: { maker: MAKER, row: publishedRow(list) }, adopted: true }) }),
      error => code(error, 'marketplace_price_rules_invalid'),
    );
  }
});

test('a price rule that cleanRule refuses is refused with its cause kept', async () => {
  const list = [{ applies_to: 'experiment:a', rule: { ...UNIT_RULE, target_win_rate: 1 } }];
  await assert.rejects(
    readPublishedPriceRules({ bootstrap: BOOT, ...ports({ item: { maker: MAKER, row: publishedRow(list) }, adopted: true }) }),
    error => code(error, 'marketplace_price_rules_invalid') && error.cause instanceof Error,
  );
});

test('a published price list that is not a list is refused', async () => {
  await assert.rejects(
    readPublishedPriceRules({ bootstrap: BOOT, ...ports({ item: { maker: MAKER, row: publishedRow({ applies_to: 'x' }) }, adopted: true }) }),
    error => code(error, 'marketplace_price_rules_invalid'),
  );
});

test('the price list section is the shipped records file at /rules', () => {
  assert.deepEqual(PRICE_RULES_SOURCE, SOURCE);
});
