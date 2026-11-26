// The site key's rights, made from its rows: exactly the tools its public rows run as the site, each tool's held names listed for
// that tool only, and every call a share cannot make as written refused with why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { askedBy, derivedGrantOf, grantDifference, heldInputsOfTools, siteCallsOf, siteRowsOf } from '../do-work/rights.ts';
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

test('an action\'s then, its next steps with their failed steps, and the sources in their when and the answer, are calls too', () => {
  const site = {
    settings,
    pages: [],
    actions: [action({
      tool: 'tool:keep-a-signup',
      then: { tool: 'tool:keep-a-journey-step', input: {} },
      next: [{ when: { $: 'pick', of: { $: 'answer', key: 'outcome' }, from: { send: true }, else: false }, tool: 'tool:send-a-mail', input: { mail: { $: 'answer', key: 'mail' } }, failed: { tool: 'tool:keep-a-signup', input: { action: 'send_failed' } } }],
      answer: { reply: { status: { $: 'tool', tool: 'tool:read-a-status', input: {}, key: 'status' } } },
    })],
  };
  const { calls } = siteCallsOf(site);
  assert.deepEqual(calls.map(call => call.tool), [RUN_SQL, 'tool:read-the-site-head', 'tool:keep-a-signup', 'tool:keep-a-journey-step', 'tool:send-a-mail', 'tool:keep-a-signup', 'tool:read-a-status']);
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

test('a plain key a mount marks share_by_listing is listed by its very name; one the row fills from the request is refused', () => {
  const plain = (tool: string) => (tool === 'tool:start-a-checkout' ? [{ path: 'secret_name', use_from_input: null, share_by_listing: true as const }] : heldOf(tool));
  const site = (input: Record<string, unknown>) => ({ settings, pages: [], actions: [action({ path: '/checkout', tool: 'tool:start-a-checkout', input, answer: { redirect_from: 'redirectUrl' } })] });
  const listed = derivedGrantOf(site({ secret_name: 'a-sellers-stripe-key' }), plain);
  assert.deepEqual(listed.refused, []);
  assert.deepEqual(listed.grant.held_inputs_by_tool['tool:start-a-checkout'], { secret_name: ['a-sellers-stripe-key'] });
  assert.match(derivedGrantOf(site({ secret_name: { $: 'body', key: 'k' } }), plain).refused[0]?.why ?? '', /filled from the request/);
  // Without the mark, the same name binds no use and a share never opens it.
  const unmarked = (tool: string) => (tool === 'tool:start-a-checkout' ? [{ path: 'secret_name', use_from_input: null }] : heldOf(tool));
  assert.match(derivedGrantOf(site({ secret_name: 'a-sellers-stripe-key' }), unmarked).refused[0]?.why ?? '', /binds no use/);
  // The real checkout row marks its secret_name mount.
  const real = heldInputsOfTools(join(import.meta.dirname, '..', '..'))('tool:start-a-stripe-checkout');
  assert.deepEqual(real?.find(item => item.path === 'secret_name'), { path: 'secret_name', use_from_input: null, share_by_listing: true });
});

test('a served_files rule\'s only_listed_by tool is a call the site makes, its database listed under that tool with the pages\' use', () => {
  const site = {
    settings: { ...settings, served_files: [{ paths: ['/app.js'] }, { paths: ['/published-clips/'], only_listed_by: { tool: 'tool:read-a-lesson', input: { database: 'site_clips', limit: 100 }, seconds: 60 } }] },
    pages: [],
    actions: [],
  };
  const { grant, refused } = derivedGrantOf(site, heldOf);
  assert.deepEqual(refused, []);
  assert.ok(grant.tools.includes('tool:read-a-lesson'));
  assert.deepEqual(grant.held_inputs_by_tool['tool:read-a-lesson'], { database: ['site_clips'] });
  assert.deepEqual(siteCallsOf(site).calls.find(call => call.where === 'settings.served_files[1].only_listed_by')?.input, { database: 'site_clips', limit: 100, use: USE });
});

test('the held inputs of every tool are read from the tools folder\'s rows', () => {
  const heldIn = heldInputsOfTools(join(import.meta.dirname, '..', '..'));
  assert.deepEqual(heldIn(RUN_SQL)?.find(item => item.path === 'database'), { path: 'database', use_from_input: 'use' });
  assert.deepEqual(heldIn('tool:read-the-site-head'), [{ path: 'database', use_from_input: 'use' }]);
  assert.equal(heldIn('tool:no-such-tool-here'), null);
});

test('in the reads mode no action is granted, and each public action is one exact pass_on entry made from the same rows', () => {
  const site = {
    settings,
    pages: [page({ path: '/courses', tool: 'tool:read-the-courses', input: { database: 'site_pages' } })],
    actions: [
      action({ path: '/target/keep', tool: 'tool:keep-a-made-booking', input: { database: 'site_records' } }),
      action({ path: '/observe/visit', tool: RUN_SQL, input: { database: 'site_records', sql: 'INSERT INTO visits (id) VALUES ($1)' } }),
      action({ path: '/members/keep', access: 'members', tool: 'tool:keep-a-made-booking', input: { database: 'site_records' } }),
      action({ path: '/book/:offer', tool: 'tool:check-when-i-am-busy' }),
    ],
  };
  const { grant, refused, pass_on_exact } = derivedGrantOf(site, heldOf, { actions: 'pass_on' });
  assert.deepEqual(grant.tools, ['tool:read-the-courses', 'tool:read-the-site-head', RUN_SQL]);
  assert.deepEqual(grant.held_inputs_by_tool, { 'tool:read-the-courses': { database: ['site_pages'] }, 'tool:read-the-site-head': { database: ['site_pages'] }, [RUN_SQL]: { database: ['site_pages'] } },
    'the page row named no use: the pages\' use is given to it, as the site gives it');
  assert.deepEqual(pass_on_exact, [{ path: '/target/keep', host: null, method: 'POST' }, { path: '/observe/visit', host: null, method: 'POST' }], 'members actions run as the member and are not passed on');
  assert.deepEqual(refused.map(item => [item.where, item.why]), [['action POST /book/:offer', 'its path has a :name part, so no exact pass_on entry can send it on']]);
});

test('a site\'s rows are read as its program reads them: the settings row first, its use checked, then its pages and its action table', async () => {
  const asked: string[] = [];
  const settingsRow = { site: 'one.example', use: USE, site_head: { tool: 'tool:read-the-site-head', input: { database: 'site_pages' } }, served_files: null, actions: 'site_actions' };
  const rows = async (sql: string, params: unknown[]) => {
    asked.push(sql.split(' FROM ')[1]?.split(' ')[0] ?? sql);
    if (sql.includes('site_settings')) return params[0] === 'one.example' ? [settingsRow] : [];
    if (sql.includes('FROM pages')) return [page({ path: '/courses', tool: 'tool:read-the-courses', input: { database: 'site_pages' } })];
    return [action({ path: '/do' })];
  };
  const site = await siteRowsOf(rows, { database: 'site_pages', use: USE, site: 'one.example' });
  assert.deepEqual(asked, ['site_settings', 'pages', '"site_actions"']);
  const { grant, refused } = derivedGrantOf(site, heldOf);
  assert.deepEqual(refused, []);
  assert.deepEqual(grant.tools, ['tool:check-when-i-am-busy', 'tool:read-the-courses', 'tool:read-the-site-head', RUN_SQL]);
  assert.deepEqual(grant.held_inputs_by_tool['tool:read-the-courses'], { database: ['site_pages'] }, 'the pages\' use is given as the site gives it');
  await assert.rejects(siteRowsOf(rows, { database: 'site_pages', use: { purpose: 'other', surface: 'x' }, site: 'one.example' }), /is not the use its rows are read under/);
  await assert.rejects(siteRowsOf(rows, { database: 'site_pages', use: USE, site: 'two.example' }), /holds 0 rows/);
  assert.deepEqual(askedBy(site, ['tool:read-the-courses', 'tool:check-when-i-am-busy']), { 'tool:read-the-courses': ['page /courses'], 'tool:check-when-i-am-busy': ['action POST /do'] });
});

test('a derived grant against the applied one: tools and held names it adds widen, ones it drops narrow, identity or journal changes widen', () => {
  const applied = { tools: ['tool:a', 'tool:b'], identity: 'none' as const, journal: 'input' as const, held_inputs_by_tool: { 'tool:a': { database: ['one', 'two'] } } };
  assert.deepEqual(grantDifference(applied, structuredClone(applied)), { same: true, widened: { tools: [], held: [], other: [] }, narrowed: { tools: [], held: [] } });
  const wider = { ...applied, tools: ['tool:a', 'tool:b', 'tool:c'], held_inputs_by_tool: { 'tool:a': { database: ['one', 'two', 'three'] } } };
  const up = grantDifference(applied, wider);
  assert.equal(up.same, false);
  assert.deepEqual(up.widened, { tools: ['tool:c'], held: [{ tool: 'tool:a', path: 'database', name: 'three' }], other: [] });
  assert.deepEqual(up.narrowed, { tools: [], held: [] });
  const down = grantDifference(applied, { ...applied, tools: ['tool:a'], held_inputs_by_tool: { 'tool:a': { database: ['one'] } } });
  assert.deepEqual(down.widened, { tools: [], held: [], other: [] });
  assert.deepEqual(down.narrowed, { tools: ['tool:b'], held: [{ tool: 'tool:a', path: 'database', name: 'two' }] });
  assert.deepEqual(grantDifference(applied, { ...applied, journal: 'none' as unknown as 'input' }).widened.other, ['journal "input" becomes "none"']);
  assert.deepEqual(grantDifference(null, applied).widened.tools, ['tool:a', 'tool:b'], 'nothing applied: everything widens');
});
