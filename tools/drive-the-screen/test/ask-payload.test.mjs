// The person's redaction, and the same redaction on what the AI reads off the screen (read-data/ask-payload.mjs).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { askSettings, redactText } from '../read-data/ask-payload.mjs';
import { makeScreenDriver, screenSettings } from '../read-data/drive-the-screen.mjs';

const settings = askSettings();
const homeOf = () => { const home = mkdtempSync(join(tmpdir(), 'ask-home-')); mkdirSync(`${home}/.trillion/capture`, { recursive: true }); return home; };
const redactOn = home => writeFileSync(`${home}/.trillion/capture/ask-prefs.json`, JSON.stringify({ redact: true }));

test('the patterns replace card numbers, emails, secret keys and id numbers, and count each replacement', () => {
  const redacted = redactText(settings, 'Pay with 4111 1111 1111 1111, mail dana@example.com, key sk_live_abcdefghijklmnop1234');
  assert.equal(redacted.text, 'Pay with [card number], mail [email], key [secret]');
  assert.equal(redacted.count, 3);
  assert.equal(redactText(settings, 'ssn 123-45-6789').text, 'ssn [id number]');
});

test('what the AI reads off the screen is redacted by the same patterns once the person turns that on', async () => {
  const home = homeOf();
  const display = { index: 0, main: true, x: 0, y: 0, width: 1000, height: 500, scale: 2 };
  const app = { name: 'Mail', bundle_id: 'test.mail', pid: 7 };
  const program = async request => ({ readiness: { ax_trusted: true, screen_capture: true }, displays: [display], frontmost: app, app,
    elements: request.max_nodes === 0 ? [] : [{ path: [0], depth: 1, role: 'AXStaticText', value: 'Reply to dana@example.com', frame: { x: 10, y: 10, width: 200, height: 20 } }], truncated: false });
  const driver = makeScreenDriver({ settings: screenSettings(), home, program, wait: async () => {} });
  const before = JSON.stringify(await driver.look({ sources: ['ax'] }));
  assert.match(before, /dana@example\.com/);
  redactOn(home);
  const after = JSON.stringify(await driver.look({ sources: ['ax'] }));
  assert.equal(after.includes('dana@example.com'), false);
  assert.match(after, /Reply to \[email\]/);
});
