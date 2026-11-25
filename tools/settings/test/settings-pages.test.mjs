// Settings' rail (src/workspace/settings-panels.json) is DATA that must draw every entry inside the settings pane, beside
// the rail. reported 1:38 PM CST Nov 25 2026: "Account & security" was an item that navigated the whole window to the sign-in
// tool's /account page, which has no rail and no way back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offeredRows } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/offered-screens.mjs';

const tools = fileURLToPath(new URL('../..', import.meta.url));
const data = JSON.parse(readFileSync(new URL('../web/src/workspace/settings-panels.json', import.meta.url), 'utf8'));
const items = data.groups.flatMap(group => group.items);
const DRAWN_BY = ['address', 'panel', 'tool'];

test('every item is one page drawn in the pane, or the one action that ends the session', () => {
  for (const item of items) {
    const drawn = DRAWN_BY.filter(key => item[key] !== undefined);
    if (item.action === undefined) assert.equal(drawn.length, 1, `${item.id} must name exactly one of ${DRAWN_BY.join(', ')}`);
    else assert.deepEqual(drawn, [], `${item.id} is an action and draws no page`);
  }
});

test('only Log out navigates the window away; no page of Settings does', () => {
  const leaving = items.filter(item => item.action === 'navigate');
  assert.deepEqual(leaving.map(item => item.id), ['sign-out']);
  assert.equal(leaving[0].href, '/sign-out');
});

test('Account & security is a tool screen drawn in the pane, and its tool offers a module that exists', () => {
  const account = items.find(item => item.id === 'account');
  assert.equal(account.tool, 'tool:screen-account');
  const offered = offeredRows(join(tools, '..')).find(row => row.id === account.tool);
  assert.ok(offered, `${account.tool} is offered by no part.json`);
  assert.equal(offered.screen.kind, 'module');
  assert.equal(offered.screen.surface, undefined, 'a tool Settings opens is not a sidebar screen of its own');
  assert.ok(existsSync(join(tools, offered.screen.module.package, offered.screen.module.entry)));
});

test('every tool a Settings item names is offered with a screen', () => {
  const offered = new Map(offeredRows(join(tools, '..')).map(row => [row.id, row]));
  for (const item of items.filter(one => one.tool && one.shown !== false && one.id !== 'contact')) assert.ok(offered.get(item.tool)?.screen, `${item.id}: ${item.tool}`);
});
