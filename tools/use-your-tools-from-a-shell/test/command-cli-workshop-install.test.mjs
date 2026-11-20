// tools/use-your-tools-from-a-shell/test/command-cli-workshop-install.test.mjs
//
// The installed example command (~/.example/cli/program) follows the Workshop copy the engine keeps current (install.follow),
// and `example setup` from a newer Workshop program refreshes every installed file that changed, the fallback when no Workshop
// copy is found. `example update` says so. Nothing else writes that copy.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installProgram, updateWords, speakFor } from '../do-work/command.mjs';
import settings from '../do-work/command.json' with { type: 'json' };

// These tests speak for one site, as an install from that site's site makes the command do.
speakFor({ cli: 'example', site_name: 'Example' });

const home = () => tempFolder(join(tmpdir(), 'trillion-workshop-install-'));
const programOf = folder => join(folder, '.example/cli/program');

test('a Workshop install updates the installed command when its program changed', () => {
  const folder = home();
  installProgram({ home: folder });
  const installed = join(programOf(folder), 'command.mjs');
  writeFileSync(installed, '// an older copy\n');
  const rows = installProgram({ home: folder });
  const outcome = rows.find(row => row.path === installed);
  assert.equal(outcome.outcome, 'updated', 'a newer Workshop program replaces the copy');
  assert.deepEqual(readFileSync(installed), readFileSync(new URL('../do-work/command.mjs', import.meta.url)));
});

test('example update says the command follows the Workshop copy and setup refreshes the installed files, and no marker file exists to skip the update', () => {
  const folder = home();
  installProgram({ home: folder });
  assert.equal(updateWords({ home: folder }), settings.update.workshop);
  assert.match(updateWords({ home: folder }), /follows the Workshop.*\(install\.follow\).*`example setup` run from the Workshop copy also refreshes the installed files/s);
  assert.ok(settings.install.follow, 'the words name a rule the install settings hold');
  assert.ok(installProgram({ home: folder }).every(row => !row.path.endsWith('install-owner.json')));
  assert.equal(settings.install.owner_file, undefined, 'the owner-marker rule is gone from the install settings');
});
