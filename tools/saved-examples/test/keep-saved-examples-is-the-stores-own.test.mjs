// The list and removal of saved examples are the person's own store's job now: no row of this folder names the records
// door, the two retired tool rows and their kits and reader are gone, and workflow:keep-saved-examples (tools/workflows)
// is the home. The recipe's expected answers are replayed here on a plain in-memory store with the same version rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import { recipeProblems } from '../../workflows/read-data/recipe-problems.mjs';
import { kitProblems } from '../../workflows/read-data/kit-problems.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const recipe = read('../../workflows/recipes/keep-saved-examples.json').records[0].payload;
const kit = read('../../workflows/kits/keep-saved-examples.json');

test('no row of this folder names the records door, and the retired tools and their reader are gone', () => {
  const text = JSON.stringify(rows.records.map(record => record.payload));
  assert.doesNotMatch(text, /"records:(read|write|list)"/);
  assert.doesNotMatch(text, /tool:list-saved-examples|tool:remove-a-saved-example/);
  for (const path of ['../read-data/saved-examples.mjs', '../kits/list-saved-examples.json', '../kits/remove-a-saved-example.json']) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  }
});

test('the recipe that replaces the list and the removal is valid, and its kit is valid for it', () => {
  assert.equal(recipe.id, 'workflow:keep-saved-examples');
  assert.deepEqual(recipeProblems(recipe), []);
  assert.deepEqual(kitProblems(kit, { recipe }), []);
});

// The replay: a plain store of rows at versions, a keep at the version read, a removal as a null value, a list newest first.
test('the example attempts in the recipe\'s prove step give the answers the store rules give', () => {
  const prove = recipe.steps.find(step => step.id === 'prove');
  const ops = JSON.parse(prove.do.slice(prove.do.indexOf('['), prove.do.indexOf('. A keep answers')));
  const store = new Map();
  const outcomes = [], answers = [];
  for (const op of ops) {
    if (op.op === 'keep') {
      const row = store.get(op.id);
      if (op.value === null && !(row && row.value !== null)) {
        outcomes.push('refused'); answers.push({ reason: `There is no saved example ${op.id} to remove.` });
        continue;
      }
      const version = (row?.version ?? 0) + 1;
      store.set(op.id, { version, value: op.value });
      outcomes.push('kept'); answers.push({ version });
    } else if (op.op === 'list') {
      const live = [...store].filter(([, row]) => row.value !== null).sort((a, b) => b[1].value.added_at.localeCompare(a[1].value.added_at)).map(([id]) => id);
      outcomes.push('answered'); answers.push({ ids: live, count: live.length });
    } else {
      outcomes.push('answered'); answers.push(store.get(op.id)?.value ?? null);
    }
  }
  const expected = prove.checks.map(check => check.values[0]);
  assert.deepEqual(expected, [outcomes, answers]);
});
