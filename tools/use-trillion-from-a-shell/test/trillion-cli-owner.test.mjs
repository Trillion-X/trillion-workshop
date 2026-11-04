// test/trillion-cli-owner.test.mjs
// The installed trillion command records who installed it (install-owner.json, copied with the program from the app that
// ships it); a program with no marker never rewrites a copy an owner installed and says which owner updates it, and a
// program that carries a marker may take the copy over (F-0183).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installProgram } from '../do-work/trillion.mjs';
import rules from '../do-work/trillion.json' with { type: 'json' };

const marker = { owner: 'the Trillion Mac app', update_hint: 'Update Trillion.app to update this command.' };
const folderOf = home => join(home, '.trillion/cli/program');

/** A folder the app ships the program in: every file the install row names and the owner's marker beside them. */
async function appCopy() {
  const source = await mkdtemp(join(tmpdir(), 'cli-owner-source-'));
  for (const name of rules.install.files) await writeFile(join(source, name), await readFile(new URL(`../do-work/${name}`, import.meta.url)));
  await writeFile(join(source, rules.install.owner_file), JSON.stringify(marker));
  return source;
}

test('a copy the app installed carries its marker; a bare install carries none', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'cli-owner-'));
  assert.ok(installProgram({ home: bare }).every(row => !row.path.endsWith(rules.install.owner_file)));
  const home = await mkdtemp(join(tmpdir(), 'cli-owner-'));
  assert.ok(installProgram({ home, from: await appCopy() }).some(row => row.path.endsWith(rules.install.owner_file) && row.outcome === 'written'));
  assert.deepEqual(JSON.parse(await readFile(join(folderOf(home), rules.install.owner_file), 'utf8')), marker);
});

test('the command does not rewrite a copy the app installed, and names the app', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cli-owner-'));
  installProgram({ home, from: await appCopy() });
  const folder = folderOf(home);
  await writeFile(join(folder, 'trillion.mjs'), '// the app version');
  const refused = installProgram({ home });
  assert.equal(refused.length, 1);
  assert.equal(refused[0].outcome, 'owned');
  assert.match(refused[0].note, /kept up to date by the Trillion Mac app/);
  assert.equal(await readFile(join(folder, 'trillion.mjs'), 'utf8'), '// the app version');
  console.log('readback:', refused[0].note);
});

test('a program that carries a marker may take over a copy a bare one made', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cli-owner-'));
  installProgram({ home });
  const rows = installProgram({ home, from: await appCopy() });
  assert.ok(rows.every(row => row.outcome !== 'owned'));
  assert.deepEqual(JSON.parse(await readFile(join(folderOf(home), rules.install.owner_file), 'utf8')), marker);
});
