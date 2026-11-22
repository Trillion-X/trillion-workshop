// tools/use-your-tools-from-a-shell/test/command-schedule-list-reads-every-page.test.mjs
//
// `schedule list` reads every page of a computer's wake list: the engine answers one page a time with `next` (trillion-rust
// e2583bd6e), and the command asks for each next page, one door message each, and prints all the wakes under the first page's
// notes. `--first-page` prints only the first page and a last line naming the cursor after it. A page that names the same
// cursor again is stopped. Nov 22 2026, from 6:15 AM CST: the Mac's whole list was 1,137,328 bytes, past one door message,
// and `schedule list --pin` was refused.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, stateOf, speakFor } from '../do-work/command.mjs';

speakFor({ cli: 'example', site_name: 'Example' });

const KEY = `nm_${'ab'.repeat(16)}`;
const noGrants = { where: 'test sign-in', read: () => null, write: () => {}, forget: () => {} };

/** A fake engine whose one computer `mac` answers its wake list in `pages`: page n after the cursor `c<n>`. */
function pagedEngine(pages) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { _meta: { [settings.engine.account_meta]: { account_id: 'acct' } }, serverInfo: {}, capabilities: { tools: {} } } });
    const args = body.params.arguments;
    asked.push(args);
    const after = args.input?.after;
    const page = after === undefined ? pages[0] : pages[Number(String(after).slice(1))];
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: page, content: [] } });
  };
  return { asked, fetchImpl };
}

const run = (engine, argv) => main([...argv, '--origin', 'http://127.0.0.1:8788'], {
  env: { EXAMPLE_KEY: KEY }, store: { read: () => KEY, where: 'test key' }, grants: noGrants,
  state: stateOf({ home: tempFolder(join(tmpdir(), 'example-schedule-pages-')) }),
  fetchImpl: engine.fetchImpl, wait: async () => {}, localDoor: () => null, computerName: 'Mac', model: null, place: () => ({}),
});

const pages = [
  { wakes: [{ tool: 'tool:a', id: 'one' }], next: 'c1', let_go: [{ why: 'noted' }], let_go_total: 1 },
  { wakes: [{ tool: 'tool:b', id: 'two' }], next: 'c2' },
  { wakes: [{ tool: 'tool:c', id: 'three' }], next: null },
];

test('schedule list follows next and prints every page\'s wakes, one door message a page', async () => {
  const engine = pagedEngine(pages);
  const text = await run(engine, ['schedule', 'list', '--pin', 'mac']);
  for (const id of ['one', 'two', 'three']) assert.ok(text.includes(`"id": "${id}"`), text);
  assert.ok(text.includes('"why": "noted"'), 'the first page\'s notes are kept');
  assert.ok(!text.includes('more after'), 'a whole list names no next page');
  const lists = engine.asked.filter(args => args.method === 'wake:list');
  assert.deepEqual(lists.map(args => args.input?.after ?? null), [null, 'c1', 'c2'], 'one ask a page, each after the last');
});

test('schedule list --first-page prints the first page and the cursor after it as its last line', async () => {
  const engine = pagedEngine(pages);
  const text = await run(engine, ['schedule', 'list', '--pin', 'mac', '--first-page']);
  assert.ok(text.includes('"id": "one"') && !text.includes('"id": "two"'), text);
  assert.equal(text.trimEnd().split('\n').at(-1), 'more after c1');
  assert.equal(engine.asked.filter(args => args.method === 'wake:list').length, 1, 'one door message');
});

test('a page that names the cursor it was asked after again is stopped, never read for ever', async () => {
  const engine = pagedEngine([{ wakes: [], next: 'c1' }, { wakes: [], next: 'c1' }]);
  await assert.rejects(run(engine, ['schedule', 'list', '--pin', 'mac']), error => error.message === settings.words.pager_stuck.replace('{site_name}', 'Example'));
});
