// The trillion command never updates itself: an install owner's marker travels with the copied program, and
// `trillion update` names that owner and what to do (do-work/trillion.mjs updateWords, do-work/trillion.json update; moved from Trillion-X/trillion test/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProgram, updateWords } from '../do-work/trillion.mjs';
import rules from '../do-work/trillion.json' with { type: 'json' };

const HERE = join(fileURLToPath(new URL('../do-work/', import.meta.url)));
const home = () => mkdtempSync(join(tmpdir(), 'trillion-owner-'));

test('with no marker, update says the only road is setup from a newer copy', () => {
  assert.match(updateWords({ home: home() }), /only when `trillion setup` is run from a newer copy/);
});

test('a marker beside the source program is copied with it, and update names its owner and hint', () => {
  const source = home();
  for (const name of rules.install.files) writeFileSync(join(source, name), readFileSync(join(HERE, name)));
  writeFileSync(join(source, 'install-owner.json'), JSON.stringify({ owner: 'the Trillion Mac app', update_hint: 'Update Trillion.app to update this command.' }));
  const target = home();
  const rows = installProgram({ home: target, from: source });
  assert.ok(rows.some(row => row.path.endsWith('install-owner.json') && row.outcome === 'written'));
  const said = updateWords({ home: target });
  assert.equal(said, 'This trillion command is kept up to date by the Trillion Mac app. Update Trillion.app to update this command. It does not update itself.');
  assert.ok(installProgram({ home: target, from: source }).every(row => row.outcome === 'unchanged'));
});

test('an unreadable marker changes nothing and is said', () => {
  const target = home();
  mkdirSync(join(target, '.trillion/cli/program'), { recursive: true });
  writeFileSync(join(target, '.trillion/cli/program/install-owner.json'), '{nope');
  assert.match(updateWords({ home: target }), /could not be read, so nothing was changed/);
});
