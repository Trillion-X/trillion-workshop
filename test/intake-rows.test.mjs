// docs/intake-2026-11-01.json: every intake item is either tied to a tool row that is here (the tool id is offered by
// some folder's rows, and the file it names holds each row id it names), or recorded as unreachable with why and what
// closes it. A recipe an item may concern must be a shipped recipe.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { json, root, rows } from '../test-helpers/tool-rows.mjs';

const ledger = json(join(root, 'docs/intake-2026-11-01.json'));
const toolIds = new Set(rows().map(({ payload }) => payload.id));
const recipeIds = new Set(json(join(root, 'tools/workflows/recipes/workflows.json')).records.map(({ payload }) => payload.id));

// Every object in a JSON value, so a row id is found wherever its file keeps its rows.
const objects = value => (value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(objects)] : []);

test('every intake item is tied to a tool row that is here, or recorded as unreachable', () => {
  assert.ok(ledger.items.length > 0);
  for (const entry of ledger.items) {
    assert.match(entry.item, /^https:\/\//, entry.item);
    assert.ok(entry.to_close, `${entry.item} says what closes it`);
    if (entry.tied_to) {
      assert.ok(toolIds.has(entry.tied_to.tool), `${entry.item}: ${entry.tied_to.tool} is a tool here`);
      const ids = new Set(objects(json(join(root, entry.tied_to.file))).map(object => object.id));
      for (const id of entry.tied_to.rows) assert.ok(ids.has(id), `${entry.item}: ${entry.tied_to.file} holds ${id}`);
    } else {
      assert.equal(entry.reached, false, `${entry.item} has no tie, so it is recorded as unreachable`);
      assert.ok(entry.unreachable_because, `${entry.item} says why it is unreachable`);
    }
    for (const id of entry.may_concern) assert.ok(recipeIds.has(id), `${entry.item}: ${id} is a shipped recipe`);
  }
});
