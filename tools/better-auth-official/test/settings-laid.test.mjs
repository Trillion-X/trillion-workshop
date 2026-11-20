// The tool's own settings are the floor: a computer's rendered settings file names only what is its own, laid over them.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { laid, readSettings } from '../settings.mjs';

test('a key the computer names wins, objects are laid key by key, a list is replaced whole', () => {
  assert.deepEqual(laid({ a: 1, o: { x: 1, y: 2 }, l: [1, 2] }, { a: 2, o: { y: 3 }, l: [9] }), { a: 2, o: { x: 1, y: 3 }, l: [9] });
  assert.deepEqual(laid({ o: { x: 1 } }, { o: null }), { o: null }, 'a computer may turn a part off');
});

test('readSettings lays the rendered file over the shipped settings, so the row carries only its own keys', () => {
  const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
  const file = join(tempFolder(join(tmpdir(), 'sign-in-settings-')), 'settings.json');
  writeFileSync(file, JSON.stringify({ site: { name: 'Example Co', storage_prefix: 'example' }, issuer: 'https://sign-in.example.com' }));
  const before = process.env.BETTER_AUTH_SETTINGS;
  process.env.BETTER_AUTH_SETTINGS = file;
  try {
    const { settings } = readSettings();
    assert.equal(settings.issuer, 'https://sign-in.example.com');
    assert.equal(settings.port, shipped.port, 'a key the row does not name comes from the tool');
    assert.deepEqual(settings.email_code, shipped.email_code);
    assert.equal(settings.session_cookie_name, '__Host-example_session');
    assert.equal(settings.two_factor_issuer, 'Example Co');
  } finally {
    if (before === undefined) delete process.env.BETTER_AUTH_SETTINGS; else process.env.BETTER_AUTH_SETTINGS = before;
  }
});

test('a settings file that cannot be read or holds no JSON object stops the server and names the file', () => {
  const folder = tempFolder(join(tmpdir(), 'sign-in-settings-'));
  const before = process.env.BETTER_AUTH_SETTINGS;
  try {
    for (const [name, text] of [['broken.json', '{"site": '], ['list.json', '[1]'], ['missing.json', null]]) {
      const file = join(folder, name);
      if (text !== null) writeFileSync(file, text);
      process.env.BETTER_AUTH_SETTINGS = file;
      assert.throws(() => readSettings(), error => error.message.includes(file), `${name} is named`);
    }
  } finally {
    if (before === undefined) delete process.env.BETTER_AUTH_SETTINGS; else process.env.BETTER_AUTH_SETTINGS = before;
  }
});
