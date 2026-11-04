// A native messaging host follows its extension: written where a browser holds it, withdrawn where it no longer does (computer/follow-presence.mjs).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { followPresence, followSettings } from '../follow-presence.mjs';

const settings = { ...followSettings(), hosts: [{ id: 'bridge', name: 'ai.example.bridge', extension_id: 'abcdefghijklmnopabcdefghijklmnop', path: '/opt/example/bridge', description: 'Bridge' }] };
const set = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'follow-'));
  mkdirSync(path.join(home, 'Applications'), { recursive: true });
  const app = settings.browsers[0].app;
  const fake = { ...settings, browsers: [{ ...settings.browsers[0], app: path.join(home, 'Chrome.app'), profiles: path.join(home, 'Chrome') }] };
  mkdirSync(fake.browsers[0].app, { recursive: true });
  return { home, fake, app, stateFile: path.join(home, 'state', 'followed.json'), extension: path.join(home, 'Chrome', 'Default', 'Extensions', settings.hosts[0].extension_id), file: path.join(home, 'Chrome', 'NativeMessagingHosts', 'ai.example.bridge.json') };
};

test('shipped DATA lists no host, so a pass writes nothing anywhere', () => {
  const { home, stateFile } = set();
  assert.deepEqual(followPresence({ home, stateFile }), { wrote: [], withdrew: [], changed: [] });
  assert.equal(existsSync(stateFile), false);
});

test('written only while the browser holds the extension, withdrawn when it is gone, left alone when changed', () => {
  const { fake, home, stateFile, extension, file } = set();
  assert.deepEqual(followPresence({ settings: fake, home, stateFile }).wrote, [], 'extension absent: nothing written');
  mkdirSync(extension, { recursive: true });
  const lines = [];
  assert.deepEqual(followPresence({ settings: fake, home, stateFile, log: line => lines.push(line) }).wrote, ['chrome:bridge']);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(written.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/']);
  assert.match(lines[0], /chrome can now reach ai\.example\.bridge/);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).ledger[0].owner, 'follow:chrome:bridge');
  assert.deepEqual(followPresence({ settings: fake, home, stateFile }).wrote, [], 'a second pass writes nothing more');
  // The extension is removed: the host goes too.
  mkdirSync(path.dirname(extension), { recursive: true });
  rmSync(extension, { recursive: true });
  assert.deepEqual(followPresence({ settings: fake, home, stateFile }).withdrew, ['chrome:bridge']);
  assert.equal(existsSync(file), false);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).ledger, []);
  // Written again, then edited by someone else: not removed.
  mkdirSync(extension, { recursive: true });
  followPresence({ settings: fake, home, stateFile });
  writeFileSync(file, '{"edited":true}\n');
  rmSync(extension, { recursive: true });
  const result = followPresence({ settings: fake, home, stateFile });
  assert.deepEqual([result.withdrew, result.changed], [[], [file]]);
  assert.equal(readFileSync(file, 'utf8'), '{"edited":true}\n');
});

test('a state file that is not an object is never replaced', () => {
  const { fake, home, stateFile, extension, file } = set();
  mkdirSync(extension, { recursive: true });
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, '[1,2');
  assert.deepEqual(followPresence({ settings: fake, home, stateFile }).wrote, []);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(stateFile, 'utf8'), '[1,2');
});

test('the reader calls it on every look of the computer', () => {
  assert.match(readFileSync(new URL(import.meta.resolve('../read-this-computer.mjs')), 'utf8'), /offer\(\); follow\(\);/);
});
