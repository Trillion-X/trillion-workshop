// A missing Mac permission is a typed refusal (read-data/drive-the-screen.mjs ready): status 409, code and permission from
// read-data/drive-the-screen.json (read-data/drive-the-screen.mjs runScreenTool passes both on to the caller beside the words, as the Mac host did).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeScreenDriver, screenSettings } from '../read-data/drive-the-screen.mjs';

const settings = screenSettings();
const DISPLAY = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };
const APP = { name: 'Probe', bundle_id: 'test.probe', pid: 4242 };
const macWith = readiness => async request => ({ readiness, displays: [DISPLAY], frontmost: APP, app: APP, truncated: false, elements: request.max_nodes === 0 ? [] : [] });
const driverOn = readiness => makeScreenDriver({ settings, home: mkdtempSync(join(tmpdir(), 'perm-home-')), program: macWith(readiness), capture: async () => Buffer.from('p'), ocr: async () => ({ width: 2000, height: 1000, lines: [] }), wait: async () => {} });

test('a missing Mac permission carries the code and the permission name from DATA, with the words and status kept', async () => {
  for (const [missing, words] of [['ax_trusted', /Accessibility/], ['screen_capture', /Screen Recording/]]) {
    const readiness = { ax_trusted: missing !== 'ax_trusted', screen_capture: missing !== 'screen_capture' };
    await assert.rejects(driverOn(readiness).look({ sources: ['ax', 'ocr'] }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, settings.permission_code);
      assert.equal(error.code, 'PERMISSION_MISSING');
      assert.equal(error.permission, missing);
      assert.match(error.message, words);
      console.log('REAL refusal:', JSON.stringify({ status: error.status, code: error.code, permission: error.permission }));
      return true;
    });
  }
});
