// The site key's rights, made from its rows: exactly the tools its public rows run as the site, each tool's held names listed for
// that tool only, and every call a share cannot make as written refused with why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { derivedGrantOf, heldInputsOfTools, siteCallsOf } from '../do-work/rights.ts';
import type { Held } from '../do-work/rights.ts';

const USE = { purpose: 'show-the-site', surface: 'site-pages' };
const RUN_SQL = 'tool:run-sql-in-my-database';
const held: Record<string, Held[]> = {
  [RUN_SQL]: [{ path: 'credential_name', use_from_input: null }, { path: 'database', use_from_input: 'use' }],
  'tool:read-the-site-head': [{ path: 'database', use_from_input: 'use' }],
  'tool:read-the-courses': [{ path: 'database', use_from_input: 'use' }],
  'tool:read-a-form-page': [{ path: 'database', use_from_input: 'use' }],
  'tool:keep-a-made-booking': [{ path: 'database', use_from_input: null }],
  'tool:check-when-i-am-busy': [],
  'tool:read-a-lesson': [{ path: 'database', use_from_input: 'use' }],
};
const heldOf = (tool: string) => held[tool] ?? null;
const settings = { pages: { database: 'site_pages', use: USE }, site_head: { tool: 'tool:read-the-site-head', input: { database: 'site_pages', site: 'one', use: USE } } };
const page = (fields: Record<string, unknown>) => ({ title: 'A page', access: 'public', layout: null, tool: null, input: {}, collection: null, updated_at: null, ...fields });
const action = (fields: Record<string, unknown>) => ({ path: '/target/do', access: 'public', tool: 'tool:check-when-i-am-busy', input: {}, answer: { json: ['ok'] }, failed: 'That did not work.', method: 'POST', ...fields });

test('the grant is exactly the tools the public rows run as the site, with each held name listed under its own tool', () => {
  const site = {
    settings,
    pages: [
      page({ path: '/courses', tool: 'tool:read-the-courses', input: { database: 'site_pages', use: USE } }),
      page({ path: '/assessment', tool: 'tool:read-a-form-page', input: { database: 'site_records', use: USE } }),
      page({ path: '/members/:lesson', access: 'members', tool: 'tool:read-a-lesson', input: { database: 'site_pages', lesson: ':lesson', use: USE } }),
      page({ path: '/', layout: [{ part: 'ui/show/text/Text.tsx', export: 'Text', children: [{ text: 'Hello' }] }, { tool: 'tool:read-the-courses', input: { database: 'site_pages', use: USE } }] }),
    ],
    actions: [action({ input: { when: { $: 'body', key: 'when' } } })],
  };
  const { grant, refused } = derivedGrantOf(site, heldOf);
  assert.deepEqual(refused, []);
  assert.deepEqual(grant.tools, ['tool:check-when-i-am-busy', 'tool:read-a-form-page', 'tool:read-the-courses', 'tool:read-the-site-head', RUN_SQL]);
  assert.ok(!grant.tools.includes('tool:read-a-lesson'), 'a members page runs with the member\'s own pass');
  assert.deepEqual(grant.held_inputs_by_tool, {
    'tool:read-a-form-page': { database: ['site_records'] },
    'tool:read-the-courses': { database: ['site_pages'] },
    'tool:read-the-site-head': { database: ['site_pages'] },
    [RUN_SQL]: { database: ['site_pages'] },
  }, 'the form page\'s database is that tool\'s alone: run-sql may not name it');
  assert.equal(grant.identity, 'none');
  assert.equal(grant.journal, 'input');
});

test('an action\'s inner tool and rows sources, and its undo, are calls the site makes', () => {
  const site = {
    settings,
    pages: [],
    actions: [action({
      tool: 'tool:check-when-i-am-busy',
      input: { free: { $: 'tool', tool: 'tool:read-the-courses', input: { database: 'site_pages', use: USE } }, count: { $: 'rows', sql: 'SELECT count(*) FROM site_courses', key: '0.count' } },
      undo: { tool: 'tool:check-when-i-am-busy', input: {} },
    })],
  };
  const { calls } = siteCallsOf(site);
  assert.deepEqual(calls.map(call => call.tool), [RUN_SQL, 'tool:read-the-site-head', 'tool:check-when-i-am-busy', 'tool:read-the-courses', RUN_SQL, 'tool:check-when-i-am-busy']);
  const { grant, refused } = derivedGrantOf(site, heldOf);
  assert.deepEqual(refused, []);
  assert.deepEqual(grant.held_inputs_by_tool[RUN_SQL], { database: ['site_pages'] }, 'a rows source runs on the pages database under the declared use');
});

test('a call a share cannot make as written is refused with why, and nothing is widened to fit it', () => {
  const site = {
    settings: { pages: { database: 'site_pages' } },
    pages: [
      page({ path: '/courses/:slug', tool: 'tool:read-the-courses', input: { database: ':slug', use: USE } }),
      page({ path: '/unknown', tool: 'tool:read-a-thing-not-here' }),
    ],
    actions: [
      action({ path: '/target/keep', tool: 'tool:keep-a-made-booking', input: { database: 'site_records' } }),
      action({ path: '/observe/visit', tool: RUN_SQL, input: { database: 'site_records', use: USE, sql: 'INSERT INTO visits (id) VALUES ($1)' } }),
      action({ path: '/target/stop', tool: RUN_SQL, input: { database: 'site_records', use: USE, sql: "WITH s AS (UPDATE stops SET at = now() RETURNING 1) SELECT 'update' FROM s" } }),
      action({ path: '/target/read', tool: RUN_SQL, input: { database: 'site_records', use: USE, sql: "SELECT 'insert, update and delete' AS words, updated_at FROM stops" } }),
    ],
  };
  const { grant, refused } = derivedGrantOf(site, heldOf);
  const why = (where: string) => refused.filter(item => item.where === where).map(item => item.why);
  assert.match(why('settings.pages')[0], /names site_pages at database with no use/);
  assert.match(why('page /courses/:slug')[0], /filled from the request/);
  assert.match(why('page /unknown')[0], /holds no row for the tool/);
  assert.match(why('action POST /target/keep')[0], /binds no use, so a share never opens it by name/);
  assert.match(why('action POST /observe/visit')[0], /not a read/);
  assert.match(why('action POST /target/stop')[0], /not a read/, 'a WITH whose part updates is a write');
  assert.deepEqual(why('action POST /target/read'), [], 'writing words inside a quoted text and a column named updated_at are a read');
  assert.ok(!grant.tools.includes('tool:read-a-thing-not-here'));
  assert.deepEqual(grant.held_inputs_by_tool, { [RUN_SQL]: { database: ['site_records'] } }, 'only the names the rows give as written, under a use');
});

test('the held inputs of every tool are read from the tools folder\'s rows', () => {
  const heldIn = heldInputsOfTools(join(import.meta.dirname, '..', '..'));
  assert.deepEqual(heldIn(RUN_SQL)?.find(item => item.path === 'database'), { path: 'database', use_from_input: 'use' });
  assert.deepEqual(heldIn('tool:read-the-site-head'), [{ path: 'database', use_from_input: 'use' }]);
  assert.equal(heldIn('tool:no-such-tool-here'), null);
});
