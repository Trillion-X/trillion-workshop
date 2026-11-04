import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import chain from '../src/escape-chain.json' with { type: 'json' };

const rows = new Map(chain.rows.map(row => [row.id, row]));
const tools = readFileSync(new URL('../records/workshop-account-tool-records.json', import.meta.url), 'utf8');

test('every escape row says its counter, its layer and how Trillion meets it', () => {
  assert.equal(rows.size, chain.rows.length, 'ids are unique');
  for (const row of chain.rows) {
    assert.ok(row.counter?.trim(), `${row.id} has a counter`);
    assert.ok(row.layer?.trim(), `${row.id} has a layer`);
    assert.ok(row.trillion?.by?.length, `${row.id} names who meets it`);
    if (row.trillion.status === 'wall') assert.ok(row.trillion.wall?.trim(), `${row.id} names its exact wall`);
    if (row.trillion.status === 'open') assert.ok(row.trillion.open?.trim(), `${row.id} says what would close it`);
    if (row.layer !== 'terminal') assert.ok(row.escape?.trim(), `${row.id} says the escape`);
  }
});

test('every next escape resolves, and every chain reaches a counter that needs nothing from the person', () => {
  for (const row of chain.rows) for (const next of row.next) assert.ok(rows.has(next), `${row.id} -> ${next}`);
  const reaches = id => {
    const seen = new Set();
    const walk = [id];
    while (walk.length) {
      const at = rows.get(walk.pop());
      if (at.layer === 'terminal') return true;
      if (seen.has(at.id)) continue;
      seen.add(at.id);
      walk.push(...at.next);
    }
    return false;
  };
  for (const row of chain.rows) assert.ok(reaches(row.id), `${row.id} reaches a terminal row`);
});

// A file in another repository is named repo:<owner>/<repository>/<path>; this tree cannot read it, so its name is
// held to that form. Every other file is this folder's, or a sibling tool's as ../<tool>/<path>, and must exist.
const ELSEWHERE = /^repo:Trillion-X\/(trillion|trillion-apps|trillion-rust)\/[\w.@-]+(\/[\w.@-]+)*$/;

test('what a built row names exists: its files, or its tool', () => {
  for (const row of chain.rows.filter(row => row.trillion.status === 'built')) {
    for (const by of row.trillion.by) {
      if (by.startsWith('tool:')) assert.ok(tools.includes(`"id": "${by}"`), `${row.id}: ${by}`);
      else if (by.startsWith('repo:')) assert.match(by, ELSEWHERE, `${row.id}: ${by}`);
      else assert.ok(existsSync(new URL(`../${by}`, import.meta.url)), `${row.id}: ${by}`);
    }
  }
});
