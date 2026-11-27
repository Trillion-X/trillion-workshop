// tools/tell-the-person: no tool here reaches the retired records door. The four notice workflows are recipes in
// tools/workflows/recipes, each with its kit in tools/workflows/kits, and their values are checked by the recipe tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

test('the tool rows hold no tool and no records-door method', () => {
  assert.deepEqual(rows.records, []);
  assert.doesNotMatch(JSON.stringify(rows), /records:(read|write|list)/);
});

test('each notice workflow has its recipe and kit in tools/workflows', () => {
  for (const name of ['read-my-notices', 'read-my-device-notices', 'mark-my-notices-read', 'act-on-my-notice']) {
    const recipe = new URL(`../../workflows/recipes/${name}.json`, import.meta.url);
    const kit = new URL(`../../workflows/kits/${name}.json`, import.meta.url);
    assert.ok(existsSync(recipe), `${name} recipe`);
    assert.ok(existsSync(kit), `${name} kit`);
    assert.equal(JSON.parse(readFileSync(recipe, 'utf8')).records[0].payload.id, `workflow:${name}`);
  }
});
