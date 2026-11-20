// test/manage-helpers.test.mjs
//
// The old tool:manage-helpers assertions (computer/test/computer-host-tools.test.mjs, the manage-helpers block, deleted by
// dc79bb0a87 and held at held-for-a-mac-host-change/test/computer-host-tools.test.mjs.held), run against the moved function
// on a pretend home. No network: the helper that is fetched is turned off before any fetch is tried.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHelperRuntimes } from '../helper-runtimes.mjs';
import { manageHelpers } from '../manage-helpers.mjs';

const home = tempFolder(join(tmpdir(), 'manage-helpers-'));
test.after(() => rmSync(home, { recursive: true, force: true }));
const runtimes = makeHelperRuntimes({ home });
const tool = input => manageHelpers(input, runtimes);

test('manage-helpers lists the helpers this Mac keeps and refuses an unknown action in words that say a retry will not help', async () => {
  const listed = await tool({ action: 'list' });
  assert.deepEqual(listed.helpers.map(row => [row.id, row.installed, row.pinned]), [['model-server', false, false]]);
  const bad = await tool({ action: 'burn' });
  assert.match(bad.error, /no helper action named burn/);
  assert.equal(bad.retry, false);
  const unknown = await tool({ action: 'ensure', id: 'nothing' });
  assert.match(unknown.error, /no helper named nothing/);
  const off = await tool({ action: 'disable', id: 'model-server' });
  assert.equal(off.enabled, false);
  assert.equal((await tool({ action: 'list' })).helpers[0].enabled, false);
  const refused = await tool({ action: 'ensure', id: 'model-server' });
  assert.match(refused.error, /was turned off/);
  assert.equal((await tool({ action: 'enable', id: 'model-server' })).enabled, true);
});
