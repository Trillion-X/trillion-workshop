// No tool sends, grants or tells an AI to call the engine's whole-source install methods. The engine deleted them with its
// install (trillion-rust card-names-only, Track B Task 3.2): every tool source is a place read where it stands, so a
// call of either method is refused as an unknown method. The old-name rejection of Task 3.6: a file here that names one is
// code or DATA that still thinks something installs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OLD = ['tools', ':update'].join('');
const OLDER = ['tools', ':rollback'].join('');

// This file names the two methods only to refuse them, so it is the one file left out.
const SELF = 'test/no-tool-sends-tools-update.test.mjs';

function filesNaming(word) {
  try {
    return execFileSync('git', ['-C', root, 'grep', '-l', '-F', word, '--', 'tools', 'test', 'test-helpers', `:!${SELF}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

test('nothing in tools/, test/ or test-helpers/ names the engine\'s deleted whole-source update or rollback', () => {
  assert.deepEqual(filesNaming(OLD), [], 'a file still names the deleted update method');
  assert.deepEqual(filesNaming(OLDER), [], 'a file still names the deleted rollback method');
});

test('the tool that installed a source is gone', () => {
  assert.equal(existsSync(join(root, 'tools/install-a-tool-source')), false);
});
