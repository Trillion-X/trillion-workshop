// tools/keep-journey-steps-from-kept-rows/test/wake-rows.test.mjs
// Every wake row of this tool uses only keys the engine accepts. The engine's wake declaration (trillion-rust src/wake.rs,
// struct Declaration, deny_unknown_fields) names them; a wake with any other key is refused as unknown_setting and never runs.
// Each key a wake here uses is also a key some other tool's wake row uses, so a key only this tool invents shows up here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const toolsDir = resolve(import.meta.dirname, '../..');
const ENGINE_WAKE_KEYS = ['id', 'on', 'budget', 'input', 'until', 'retry', 'skip_unchanged', 'rate', 'replay', 'needs_input', 'on_failure'];

/** The wake rows a what-this-tool-does-and-how-to-run-it.json declares: each object under a "wakes" list, at any depth. */
function wakesIn(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) wakesIn(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'wakes' && Array.isArray(child)) found.push(...child.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)));
      else wakesIn(child, found);
    }
  }
  return found;
}

/** Every object under `value` whose `key` is `expected`. */
function objectsWith(value, key, expected, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) objectsWith(item, key, expected, found);
  } else if (value !== null && typeof value === 'object') {
    if (value[key] === expected) found.push(value);
    for (const child of Object.values(value)) objectsWith(child, key, expected, found);
  }
  return found;
}

const rowsOf = tool => JSON.parse(readFileSync(resolve(toolsDir, tool, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8'));
const keysOf = wakes => new Set(wakes.flatMap(wake => Object.keys(wake)));

test('every wake row of this tool uses only keys the engine accepts', () => {
  const wakes = wakesIn(rowsOf('keep-journey-steps-from-kept-rows'));
  assert.equal(wakes.length, 3);
  const accepted = new Set(ENGINE_WAKE_KEYS);
  for (const wake of wakes) {
    const unknown = Object.keys(wake).filter(key => !accepted.has(key));
    assert.deepEqual(unknown, [], `${wake.id} uses a key the engine does not accept`);
  }
});

test('the keys this tool wake rows use are keys other tools wake rows use too', () => {
  const own = keysOf(wakesIn(rowsOf('keep-journey-steps-from-kept-rows')));
  const others = new Set();
  for (const tool of readdirSync(toolsDir)) {
    if (tool === 'keep-journey-steps-from-kept-rows' || !existsSync(resolve(toolsDir, tool, 'what-this-tool-does-and-how-to-run-it.json'))) continue;
    for (const key of keysOf(wakesIn(rowsOf(tool)))) others.add(key);
  }
  const invented = [...own].filter(key => !others.has(key));
  assert.deepEqual(invented, []);
});

test('every fact wake of this tool matches a field the row-changes waiter puts in its fact', () => {
  // The row-changes waiter (notice-when-something-shows-up, its keep-noticing-row-changes wake's input) names the fields of each
  // fact it tells: where, place, change, at, key, before, after, by. A wake's match names one of those; another name is never equal.
  const noticer = JSON.parse(readFileSync(resolve(toolsDir, 'notice-when-something-shows-up/what-this-tool-does-and-how-to-run-it.json'), 'utf8'));
  const rowChanges = objectsWith(noticer, 'mechanism_leaf', 'row-changes.mjs');
  assert.equal(rowChanges.length, 1);
  const told = new Set([...rowChanges[0].emitted_record.payload_fields, 'kind']);
  for (const wake of wakesIn(rowsOf('keep-journey-steps-from-kept-rows'))) {
    // Only the row-change wakes: a due-time wake matches its schedule, from the schedule's own fact.
    if (wake.on?.fact?.kind !== 'something-changed') continue;
    const named = Object.keys(wake.on.fact.match ?? {});
    assert.deepEqual(named.filter(field => !told.has(field)), [], `${wake.id} matches a field the waiter does not tell`);
  }
});

