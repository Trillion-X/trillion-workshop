// test/held-session.test.mjs
// held-session.mjs reads the proof account's cookies from the mounted descriptor, keyed by origin. These tests mount a fake value on
// a real descriptor and check: each origin gets its own cookies; a missing, empty or misshapen mount is refused; and no refusal
// carries a cookie's value.
import assert from 'node:assert/strict';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { heldSessionExpiries, readHeldSessions, sessionFor } from '../held-session.mjs';

const VALUE = 'not-a-real-session-value';

async function mounted(text) {
  const folder = await tempFolder('held-session-');
  const path = join(folder, 'mount');
  writeFileSync(path, text);
  const fd = openSync(path, 'r');
  try { return await readHeldSessions({ fd }); } finally { try { closeSync(fd); } catch {} }
}

test('each origin gets its own cookies, and a page of another origin is refused', async () => {
  const sessions = await mounted(JSON.stringify({
    'https://app.gettrillion.ai': [{ name: 'better-auth.session_token', value: VALUE, secure: true, httpOnly: true }],
    'https://app.ethosschooloftennis.com': [{ name: 'better-auth.session_token', value: 'other' }],
  }));
  assert.equal(sessionFor(sessions, 'https://app.gettrillion.ai/home?x=1')[0].value, VALUE);
  assert.equal(sessionFor(sessions, 'https://app.ethosschooloftennis.com/members')[0].value, 'other');
  assert.throws(() => sessionFor(sessions, 'https://example.com/'), error => error.code === 'no_held_session' && /example\.com/.test(error.message));
});

test('a misshapen mount is refused without its value in the words', async () => {
  for (const text of ['', 'not json', '[]', JSON.stringify({ 'https://a.example/path': [{ name: 'n', value: VALUE }] }),
    JSON.stringify({ 'https://a.example': [] }), JSON.stringify({ 'https://a.example': [{ name: 'n' }] })]) {
    await assert.rejects(mounted(text), error => error.code === 'no_held_session' && !error.message.includes(VALUE));
  }
});

test('nothing mounted is refused as no_held_session', async () => {
  await assert.rejects(readHeldSessions({ fd: 987 }), error => error.code === 'no_held_session');
});

test('the expiries answer each origin\'s session end, the latest of its cookies, and no cookie value', async () => {
  const now = Date.UTC(2026, 10, 21);
  const readHeld = async () => new Map([
    ['https://app.gettrillion.ai', [{ name: 'a', value: VALUE, expires: now / 1000 + 3 * 86400 }, { name: 'b', value: VALUE, expires: now / 1000 + 86400 }]],
    ['https://app.ethosschooloftennis.com', [{ name: 'a', value: VALUE, expires: -1 }]],
  ]);
  const accounts = { renew_when_days_left: 2, accounts: [{ origin: 'https://app.gettrillion.ai' }, { origin: 'https://app.ethosschooloftennis.com' }] };
  const answer = await heldSessionExpiries({}, undefined, { readHeld, now, accounts });
  assert.equal(answer.renew, false);
  assert.equal((await heldSessionExpiries({}, undefined, { readHeld, now: now + 2 * 86400000, accounts })).renew, true, 'within 2 days of its end');
  assert.equal((await heldSessionExpiries({}, undefined, { readHeld, now, accounts: { ...accounts, accounts: [...accounts.accounts, { origin: 'https://new.example' }] } })).renew, true, 'an account with no session');
  assert.deepEqual(answer.origins, [
    { origin: 'https://app.gettrillion.ai', expires_at: '2026-11-24T00:00:00.000Z', days_left: 3, cookies: [
      { name: 'a', expires_at: '2026-11-24T00:00:00.000Z' }, { name: 'b', expires_at: '2026-11-22T00:00:00.000Z' }] },
    { origin: 'https://app.ethosschooloftennis.com', expires_at: null, days_left: null, cookies: [{ name: 'a', expires_at: null }] },
  ]);
  assert.ok(!JSON.stringify(answer).includes(VALUE));
});
