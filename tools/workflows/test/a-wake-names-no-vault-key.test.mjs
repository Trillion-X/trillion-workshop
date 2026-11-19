// tools/workflows: no recipe's wake input names a vault key. A wake's input fields win over the switch's (trillion-rust
// src/wake.rs with_switch_input), so a vault name written in a shared row is the only one any person's run can use:
// stop-programs-left-running and send-each-post-at-its-time pinned "the-persons-database-connection", and a person who
// switched one on with their own store's login still ran under that name (found Nov 19 2026). The person's vault names
// come with their switch.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const recipes = new URL('../recipes/', import.meta.url);
const named = (value, at = '') => {
  if (Array.isArray(value)) return value.flatMap((item, index) => named(item, `${at}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    (/credential_name$|secret_name$/.test(key) && typeof item === 'string' ? [`${at}.${key}`] : []).concat(named(item, `${at}.${key}`)));
};

test('no recipe wake declares a vault name in its input', () => {
  const found = [];
  for (const file of readdirSync(recipes).filter(name => name.endsWith('.json'))) {
    for (const { payload } of JSON.parse(readFileSync(new URL(file, recipes), 'utf8')).records ?? []) {
      for (const wake of payload?.wakes ?? []) for (const at of named(wake.input ?? {})) found.push(`${payload.id} ${wake.id} input${at}`);
    }
  }
  assert.deepEqual(found, []);
});
