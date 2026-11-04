// tools/bring-in-new-items-from-this-computer/test/one-owner.test.mjs
//
// The computer's places have one owner, this folder. No other tool folder keeps a copy of a file that lives here.
// The programs that read a computer (tools/run-on-a-persons-computer) never read place rows beside themselves. Every
// `workshop` path they name, and every download address of the Mac Contacts setup line, names a file in this tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HERE = path.join(ROOT, 'tools/bring-in-new-items-from-this-computer/computer');
const RUN_ON = path.join(ROOT, 'tools/run-on-a-persons-computer');
const OWNED = ['computer-sources.json', 'computer-sources.mjs', 'read-new-items.mjs', 'read-new-items.json', 'own-writes.mjs', 'own-writes.json',
  'connections/imessage.mjs', 'connections/whatsapp.mjs', 'connections/incoming-items.mjs', 'connections/README.md', 'sync-contacts.zsh', 'sync-contacts.js', 'sync-contacts.json'];

test('run-on-a-persons-computer keeps no copy of a file that lives here', () => {
  for (const file of OWNED) {
    assert.ok(fs.existsSync(path.join(HERE, file)), `${file} lives here`);
    assert.equal(fs.existsSync(path.join(RUN_ON, file)), false, `run-on-a-persons-computer/${file} is a second copy`);
  }
});

test('no program in run-on-a-persons-computer reads place rows or the readers beside itself', () => {
  for (const name of fs.readdirSync(RUN_ON).filter(file => file.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(RUN_ON, name), 'utf8');
    assert.doesNotMatch(text, /join\(HERE, 'computer-sources\.json'\)|new URL\('\.\/computer-sources\.json'|from '\.\/(computer-sources|own-writes|read-new-items)\.mjs'|'\.\/connections\//, name);
  }
});

test('every workshop path the local door and the carried connections name is a file in tools/', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(RUN_ON, 'mac-tools.json'), 'utf8'));
  const rows = [...Object.values(settings.tools ?? {}), ...(settings.on_start ?? [])];
  const named = [...rows.map(row => row.workshop), ...rows.flatMap(row => [...Object.values(row.with ?? {}), ...Object.values(row.hand ?? {})].map(from => from.workshop)),
    ...JSON.parse(fs.readFileSync(path.join(RUN_ON, 'carry-connections.json'), 'utf8')).connections.map(row => row.workshop)].filter(Boolean);
  assert.ok(named.some(file => file.startsWith('tools/bring-in-new-items-from-this-computer/')));
  for (const file of named) {
    assert.match(file, /^tools\/[a-z0-9-]+\//, file);
    assert.ok(!file.split('/').includes('..'), file);
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} names no file`);
  }
});

test('the Mac Contacts setup line downloads from this folder, at addresses that name files here', () => {
  const texts = [fs.readFileSync(path.join(ROOT, 'tools/connect-a-service-and-seal-its-key/records.json'), 'utf8'), fs.readFileSync(path.join(HERE, 'sync-contacts.zsh'), 'utf8')];
  const named = texts.flatMap(text => [...text.matchAll(/https:\/\/raw\.githubusercontent\.com\/Trillion-X\/trillion-workshop\/main\/([^\s"\\]+)/g)].map(match => match[1]));
  for (const ending of ['zsh', 'js', 'json']) assert.ok(named.includes(`tools/bring-in-new-items-from-this-computer/computer/sync-contacts.${ending}`), ending);
  for (const file of named) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} names no file here`);
  for (const text of texts) assert.doesNotMatch(text, /gettrillion\.ai\/computer\//);
});
