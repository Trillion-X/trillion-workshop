import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettingsFile, writeSettingsFile, ParkedWrite } from '../read-data/settings-file.mjs';
import { grantTools, screenSettings } from '../read-data/drive-the-screen.mjs';

test('missing is not degraded; unreadable shapes are, and a write to them is parked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-'));
  const file = join(dir, 'a.json');
  assert.equal(readSettingsFile(file).state, 'missing');
  writeSettingsFile(file, { grants: [] });
  assert.equal(readSettingsFile(file).state, 'ok');
  writeFileSync(file, '{ not json');
  assert.deepEqual(readSettingsFile(file), { state: 'degraded', why: 'not_json' });
  assert.throws(() => writeSettingsFile(file, { grants: [] }), ParkedWrite);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  writeFileSync(file, '{"other":1}');
  assert.equal(readSettingsFile(file, { accept: v => Array.isArray(v.grants) }).why, 'wrong_shape');
});

test('the screen grant tools never replace a broken permissions file with an empty one', () => {
  const settings = screenSettings();
  const home = mkdtempSync(join(tmpdir(), 'sg-'));
  const file = join(home, settings.consent.file);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '{"grants": [ broken', { mode: 0o600 });
  const tools = grantTools(settings, { home });
  assert.throws(() => tools.grant({ actions: ['look'], minutes: 5 }), error => { console.log('READBACK', error.status, error.message); return error.status === 409 && error.reaction === 'ask_user'; });
  assert.throws(() => tools.revoke({}), /nothing was written/);
  assert.equal(readFileSync(file, 'utf8'), '{"grants": [ broken');
  writeFileSync(file, '{"grants": []}', { mode: 0o600 });
  assert.equal(tools.grant({ actions: ['look'], minutes: 5 }).grant.actions[0], 'look');
});
