// The check that a site's applied act still matches its rows: the act is derived again from the rows as they are, the same way
// (this folder's rights.ts, with made-up tool rows) and compared with what the computer row last applied. A widening needs a
// person; a narrowing alone may be applied; a refusal needs a person; a hand act has nothing to be checked against.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as rights from '../do-work/rights.ts';
import type { Held } from '../do-work/rights.ts';
import { askedOf, checkASitesAct, installedRowsFrom } from '../do-work/check-a-sites-act.ts';
import type { Rights } from '../do-work/check-a-sites-act.ts';

const USE = { purpose: 'publish', surface: 'site/one' };
const PIN = '4'.repeat(40);
const RUN_SQL = 'tool:run-sql-in-my-database';
const held: Record<string, Held[]> = {
  [RUN_SQL]: [{ path: 'database', use_from_input: 'use' }],
  'tool:read-the-courses': [{ path: 'database', use_from_input: 'use' }],
  'tool:start-a-booking': [{ path: 'database', use_from_input: 'use' }],
};
const localRights = { ...rights, heldInputsOfTools: () => (tool: string) => held[tool] ?? null } as unknown as Rights;
const page = (path: string, tool: string | null, input: unknown = { database: 'site_db' }) => ({ path, title: path, access: 'public', layout: null, tool, input, collection: null, updated_at: null, host: null });
const action = (path: string, tool: string) => ({ path, access: 'public', tool, input: { database: 'site_db' }, answer: { json: ['ok'] }, failed: 'No.', method: 'POST' });

// A tool's row as the pin has it, and as the engine's tools:list answers it when it runs that row.
const rowOf = (tool: string) => ({ id: tool, label: tool, job: `do ${tool}`, description: `${tool} words`, input_schema: { type: 'object', properties: { database: { type: 'string' } } }, output_schema: { type: 'object' } });
function world(applied: rights.Grant | null, { pages = [page('/courses', 'tool:read-the-courses')], actions = [] as Record<string, unknown>[], act, installed = rowOf }: { pages?: unknown[]; actions?: Record<string, unknown>[]; act?: unknown; installed?: (tool: string) => Record<string, unknown> | null } = {}) {
  const from = { connection: 'site-rows', database: 'site_db', use: USE, site: 'one', pin: PIN };
  const runs = { units: [{ settings: { vault_readers: [{ uid: 1106, act: act ?? { derive_from: from, ...(applied ? { derived: { pin: PIN, grant: applied } } : {}) } }, { uid: 1104 }] } }] };
  const asked: { credential: string; sql: string }[] = [];
  const pins: string[] = [];
  return {
    asked, pins,
    deps: {
      async runSql(credential: string, sql: string, params: unknown[]) {
        asked.push({ credential, sql: sql.slice(0, 40) });
        if (sql.includes('FROM computer')) return params[0] === 'box' ? [{ runs: JSON.stringify(runs) }] : [];
        if (sql.includes('site_settings')) return [{ value: { use: USE, actions: 'site_actions' } }];
        if (sql.includes('FROM pages')) return pages as Record<string, unknown>[];
        return actions;
      },
      async rightsAt(pin: string) { pins.push(pin); return { rights: localRights, tools: '/made-up-tools', rowOf }; },
      async installedRows(tools: string[]) { return new Map(tools.flatMap(tool => { const row = installed(tool); return row ? [[tool, row] as [string, Record<string, unknown>]] : []; })); },
      identity: (value: unknown) => `id:${JSON.stringify(value).length}`,
    },
  };
}
const asked = { computer_row: 'box', uid: 1106, store: 'computers' };
const grantOf = (tools: string[], heldBy: Record<string, Record<string, string[]>> = {}): rights.Grant => ({ tools, identity: 'none', journal: 'input', held_inputs_by_tool: heldBy });
const NOW = grantOf([RUN_SQL, 'tool:read-the-courses'], { [RUN_SQL]: { database: ['site_db'] }, 'tool:read-the-courses': { database: ['site_db'] } });

test('rows that ask for what the applied act gives answer same, read through the held connections the row names', async () => {
  const { deps, asked: ran, pins } = world(NOW);
  const answer = await checkASitesAct(asked, deps);
  assert.equal(answer.same, true);
  assert.equal(answer.needs_a_person, false);
  assert.equal(answer.narrowed_only, false);
  assert.deepEqual(pins, [PIN], 'derived at the act\'s own pin');
  assert.deepEqual([...new Set(ran.map(r => r.credential))], ['computers', 'site-rows']);
  assert.deepEqual([answer.derived_tools, answer.applied_tools], [2, 2]);
});

test('a row that asks for a new tool widens: it needs a person, and the rows asking for it are named', async () => {
  const { deps } = world(NOW, { actions: [action('/book', 'tool:start-a-booking')] });
  const answer = await checkASitesAct(asked, deps);
  assert.equal(answer.needs_a_person, true);
  assert.equal(answer.narrowed_only, false);
  assert.deepEqual(answer.widened.tools, ['tool:start-a-booking']);
  assert.deepEqual(answer.asked_by, { 'tool:start-a-booking': ['action POST /book'] });
});

test('rows that drop a tool narrow only, which may be applied without a person', async () => {
  const { deps } = world(NOW, { pages: [{ ...page('/plain', null), layout: { part: 'ui/show/text/Text.tsx', export: 'Text', children: [{ text: 'Plain words' }] } }] });
  const answer = await checkASitesAct(asked, deps);
  assert.equal(answer.needs_a_person, false);
  assert.equal(answer.narrowed_only, true);
  assert.deepEqual(answer.narrowed.tools, ['tool:read-the-courses']);
});

test('a call no grant can make as written needs a person; an act given by hand, or an unknown row, is refused by name', async () => {
  const { deps } = world(NOW, { pages: [page('/courses', 'tool:read-the-courses'), page('/c/:slug', 'tool:read-the-courses', { database: ':slug' })] });
  const answer = await checkASitesAct(asked, deps);
  assert.equal(answer.needs_a_person, true);
  assert.equal(answer.refused.length, 1);
  await assert.rejects(checkASitesAct(asked, world(NOW, { act: NOW }).deps), /is not given as \{ derive_from \}/);
  await assert.rejects(checkASitesAct({ ...asked, computer_row: 'other' }, world(NOW).deps), /No computer row is named other/);
  await assert.rejects(checkASitesAct({ ...asked, uid: 7 }, world(NOW).deps), /has 0 vault readers with uid 7/);
  const first = await checkASitesAct(asked, world(null).deps);
  assert.equal(first.needs_a_person, true, 'an act never applied widens from nothing');
});

test('the input is { computer_row, uid, store } and nothing else', () => {
  assert.deepEqual(askedOf(asked), asked);
  for (const bad of [{}, { ...asked, uid: '1106' }, { ...asked, store: 'a b' }, { ...asked, extra: 1 }, null]) assert.throws(() => askedOf(bad), /Give \{ computer_row/, JSON.stringify(bad));
});

test('the check judges only what this engine runs: a tool installed with another row than the pin\'s, or not installed, refuses it by name', async () => {
  const changed = (tool: string) => (tool === RUN_SQL ? { ...rowOf(tool), input_schema: { type: 'object', properties: { sql: { type: 'string' } } } } : rowOf(tool));
  await assert.rejects(checkASitesAct(asked, world(NOW, { installed: changed }).deps), new RegExp(`does not run the act's pin ${PIN}: ${RUN_SQL} \\(its input_schema differ\\)`));
  const missing = (tool: string) => (tool === 'tool:start-a-booking' ? null : rowOf(tool));
  await assert.rejects(checkASitesAct(asked, world(NOW, { actions: [action('/book', 'tool:start-a-booking')], installed: missing }).deps), /tool:start-a-booking \(not installed on this engine\)/);
  // A row whose keys come back in another order is the same row.
  const reordered = (tool: string) => Object.fromEntries(Object.entries(rowOf(tool)).reverse());
  assert.equal((await checkASitesAct(asked, world(NOW, { installed: reordered }).deps)).same, true);
});

test('the engine\'s rows are read from its own tools:list: every page of ids, then each named tool alone', async () => {
  const asks: unknown[] = [];
  const door = {
    toolsAddress: '@tools',
    async operation(method: string, input: Record<string, unknown>, { at }: { at: string }) {
      asks.push([method, input, at]);
      if (input.tool) return rowOf(String(input.tool));
      return input.after ? { tools: [{ id: 'tool:b' }], next: null } : { tools: [{ id: 'tool:a' }], next: 'workshop/tool:a' };
    },
  };
  const rows = await installedRowsFrom(door)(['tool:a', 'tool:b', 'tool:c']);
  assert.deepEqual([...rows.keys()], ['tool:a', 'tool:b'], 'a tool the engine does not list is not read');
  assert.deepEqual(asks, [['tools:list', {}, '@tools'], ['tools:list', { after: 'workshop/tool:a' }, '@tools'], ['tools:list', { tool: 'tool:a' }, '@tools'], ['tools:list', { tool: 'tool:b' }, '@tools']]);
});
