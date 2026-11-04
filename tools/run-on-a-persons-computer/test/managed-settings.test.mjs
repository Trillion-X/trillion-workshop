// Managed preferences (computer/managed-settings.mjs): a company's configuration profile is read as DATA-listed keys,
// typed, with their source; no profile changes nothing; a profile turning local_models off stops the Mac answering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedSettingsData, readManagedSettings, turnedOff } from '../managed-settings.mjs';

const homeWith = files => {
  const home = mkdtempSync(join(tmpdir(), 'managed-'));
  for (const [name, body] of Object.entries(files)) { mkdirSync(join(home, name, '..'), { recursive: true }); writeFileSync(join(home, name), body); }
  return home;
};
// Test data points the system-wide source at the temporary home, so the real /Library is never read.
const data = home => ({ ...managedSettingsData(), sources: [
  { id: 'managed profile', file: `${home}/System/{domain}.plist` },
  { id: 'managed profile for this person', file: '~/Library/Managed Preferences/{domain}.plist' },
  { id: 'test override', file: '~/.trillion/managed-settings.json', json: true }] });

test('no profile manages nothing', async () => {
  const home = homeWith({});
  assert.deepEqual(await readManagedSettings({ data: data(home), home }), { settings: {}, ignored: [] });
  assert.equal(turnedOff({ settings: {} }, 'local_models'), null);
});

test('a real property list is read with plutil, typed per DATA, with its source, and wrong or unknown keys are named and ignored', async () => {
  const home = homeWith({});
  const plist = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>local_models</key><false/><key>updates</key><string>no</string><key>allowed_ais</key><array><string>claude-code</string></array><key>mystery</key><true/></dict></plist>';
  mkdirSync(join(home, 'System'), { recursive: true });
  writeFileSync(join(home, 'System/ai.gettrillion.macos.plist'), plist);
  const read = await readManagedSettings({ data: data(home), home });
  assert.deepEqual(read.settings, { local_models: { value: false, source: 'managed profile' }, allowed_ais: { value: ['claude-code'], source: 'managed profile' } });
  assert.deepEqual([...read.ignored].sort(), ['mystery is not a setting this app reads.', 'updates must be boolean.']);
  assert.equal(turnedOff(read, 'local_models'), 'Your organisation turned local_models off on this Mac (managed profile).');
  assert.equal(turnedOff(read, 'allowed_ais'), null);
  assert.equal(execFileSync('/usr/bin/plutil', ['-lint', join(home, 'System/ai.gettrillion.macos.plist')]).toString().includes('OK'), true);
});

test('of two sources naming one key the earlier wins, and an unreadable file is no profile', async () => {
  const home = homeWith({ '.trillion/managed-settings.json': '{"updates": false, "local_models": true}', 'Library/Managed Preferences/ai.gettrillion.macos.plist': 'not a plist' });
  const read = await readManagedSettings({ data: data(home), home, plutil: async file => { if (file.includes('Managed Preferences')) throw new Error('bad'); throw new Error('absent'); } });
  assert.deepEqual(read.settings, { updates: { value: false, source: 'test override' }, local_models: { value: true, source: 'test override' } });
});
