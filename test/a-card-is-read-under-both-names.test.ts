// The card is read under both its names for the one release the engine reads both (trillion-rust
// src/tool_runs/tools/card.rs): a folder's card is what-this-tool-does-and-how-to-run-it.json or the older tool-rows.json,
// and a row's invoke may say run / key / may_reach for argv / credential_mounts / internet + hosts. Both file names in one
// folder, or one field named both ways in one row, is refused, naming both. Read through test-helpers/tool-rows.mjs, the
// reader every Workshop test reads the cards with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asRead, cardFiles, rowsIn } from '../test-helpers/tool-rows.mjs';
import { tempFolder } from '../test-helpers/temp-folder.mjs';

const [newName, oldName] = cardFiles as [string, string];

function toolsWith(cards: Record<string, Record<string, unknown>>): string {
  const within = tempFolder(join(tmpdir(), 'card-names-'));
  for (const [path, card] of Object.entries(cards)) {
    mkdirSync(join(within, path, '..'), { recursive: true });
    writeFileSync(join(within, path), JSON.stringify(card));
  }
  return within;
}

const row = (id: string, invoke: Record<string, unknown>) => ({ payload: { kind: 'ai-tool-descriptor', id, invoke } });

test('the new card name is read first and the older name still reads', () => {
  assert.equal(newName, 'what-this-tool-does-and-how-to-run-it.json');
  assert.equal(oldName, 'tool-rows.json');
  const within = toolsWith({
    [`old/${oldName}`]: { records: [row('old-run', { kind: 'container', argv: ['sh', 'go.sh'], credential_mounts: [{ secret_name: 'k', fd: 3 }] })] },
    [`new/${newName}`]: { records: [row('new-run', { kind: 'container', run: ['sh', 'go.sh'], key: [{ secret_name: 'k', fd: 3 }], may_reach: ['a.test'] })],
      prepare: ['npm', 'install', '--omit=dev'], needs_tools: ['old'] },
  });
  const [old] = rowsIn(within, 'old');
  const [fresh] = rowsIn(within, 'new');
  assert.ok(old && fresh, 'each folder lists its row');
  assert.equal(typeof old.payload.id, 'string');
  assert.equal(old.payload.id, 'old-run');
  assert.ok(Array.isArray(old.payload.invoke.argv));
  assert.deepEqual(old.payload.invoke.argv, ['sh', 'go.sh']);
  const invoke = fresh.payload.invoke;
  assert.ok(Array.isArray(invoke.argv) && !('run' in invoke), 'run is read as argv');
  assert.deepEqual(invoke.argv, ['sh', 'go.sh']);
  assert.ok(Array.isArray(invoke.credential_mounts) && !('key' in invoke), 'key is read as credential_mounts');
  assert.deepEqual(invoke.credential_mounts, [{ secret_name: 'k', fd: 3 }]);
  assert.equal(typeof invoke.internet, 'boolean');
  assert.equal(invoke.internet, true);
  assert.ok(Array.isArray(invoke.hosts) && !('may_reach' in invoke), 'may_reach is read as hosts');
  assert.deepEqual(invoke.hosts, ['a.test']);
});

test('a folder holding its card under both names is refused, naming both files', () => {
  const within = toolsWith({
    [`both/${newName}`]: { records: [row('both-new', { kind: 'container', run: ['true'] })] },
    [`both/${oldName}`]: { records: [row('both-old', { kind: 'container', argv: ['true'] })] },
  });
  assert.throws(() => rowsIn(within, 'both'), (error: Error) => {
    assert.ok(typeof error.message === 'string');
    assert.ok(error.message.includes(join(within, 'both', newName)) && error.message.includes(join(within, 'both', oldName)), error.message);
    return true;
  });
});

test('a row naming one field both ways is refused, naming both names', () => {
  const both = (invoke: Record<string, unknown>) => {
    assert.throws(() => asRead('x', { kind: 'ai-tool-descriptor', id: 'mixed', invoke }), (error: Error) => {
      assert.ok(typeof error.message === 'string');
      return /names one field both ways/.test(error.message);
    });
  };
  both({ run: ['true'], argv: ['true'] });
  both({ key: [], credential_mounts: [] });
  both({ may_reach: [], internet: true });
  both({ may_reach: ['a.test'], credential_injections: [{ hosts: ['a.test'] }] });
  both({ run: ['true'], by_input: { input: 'p', variants: { v: { argv: ['true'] } } } });
  const elsewhere = asRead('x', { kind: 'ai-tool-descriptor', id: 'there', invoke: { kind: 'on-your-computer', run: 'probe {input}' } });
  assert.equal(typeof elsewhere.invoke.run, 'string', "an on-your-computer row's text run is its own field");
  assert.equal(elsewhere.invoke.run, 'probe {input}');
  assert.ok(!('argv' in elsewhere.invoke));
});

test("a card's prepare and needs_tools are checked for their shapes", () => {
  for (const card of [{ prepare: [] }, { prepare: 'npm install' }, { needs_tools: ['../ui'] }, { needs_tools: ['ui', 'ui'] }]) {
    const within = toolsWith({ [`bad/${newName}`]: { records: [], ...card } });
    assert.throws(() => rowsIn(within, 'bad'), JSON.stringify(card));
  }
});
