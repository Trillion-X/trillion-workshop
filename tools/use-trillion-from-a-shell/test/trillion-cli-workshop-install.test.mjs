// tools/use-trillion-from-a-shell/test/trillion-cli-workshop-install.test.mjs
//
// The installed trillion command (~/.trillion/cli/program) follows the Workshop copy the engine keeps current (install.follow),
// and `trillion setup` from a newer Workshop program refreshes every installed file that changed, the fallback when no Workshop
// copy is found. `trillion update` says so. Nothing else writes that copy.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installProgram, updateWords, speakFor } from '../do-work/trillion.mjs';
import settings from '../do-work/trillion.json' with { type: 'json' };

// These tests speak for one brand, as an install from that brand's site makes the command do.
speakFor({ cli: 'trillion', brand: 'Trillion' });

const home = () => mkdtempSync(join(tmpdir(), 'trillion-workshop-install-'));
const programOf = folder => join(folder, '.trillion/cli/program');

test('a Workshop install updates the installed command when its program changed', () => {
  const folder = home();
  installProgram({ home: folder });
  const installed = join(programOf(folder), 'trillion.mjs');
  writeFileSync(installed, '// an older copy\n');
  const rows = installProgram({ home: folder });
  const outcome = rows.find(row => row.path === installed);
  assert.equal(outcome.outcome, 'updated', 'a newer Workshop program replaces the copy');
  assert.deepEqual(readFileSync(installed), readFileSync(new URL('../do-work/trillion.mjs', import.meta.url)));
});

test('trillion update says the command follows the Workshop copy and setup refreshes the installed files, and no marker file exists to skip the update', () => {
  const folder = home();
  installProgram({ home: folder });
  assert.equal(updateWords({ home: folder }), settings.update.workshop);
  assert.match(updateWords({ home: folder }), /follows the Workshop.*\(install\.follow\).*`trillion setup` run from the Workshop copy also refreshes the installed files/s);
  assert.ok(settings.install.follow, 'the words name a rule the install settings hold');
  assert.ok(installProgram({ home: folder }).every(row => !row.path.endsWith('install-owner.json')));
  assert.equal(settings.install.owner_file, undefined, 'the owner-marker rule is gone from the install settings');
});
