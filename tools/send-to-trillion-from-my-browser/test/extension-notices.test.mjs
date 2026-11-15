// Trillion's notices in the Send to Trillion extension (extension/src/notices.mjs) and the toolbar badge's one owner
// (extension/src/badge.mjs firstMark): a pushed notice becomes a browser notification whose buttons are its own
// actions and whose loudness comes from DATA; the badge shows the first mark that says something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLabel, bytesFromBase64url, notificationFor, sameBytes, unreadCount } from '../src/notices.mjs';
import { firstMark } from '../src/badge.mjs';
import settings from '../settings.json' with { type: 'json' };
import words from '../words.json' with { type: 'json' };

const shape = { ...settings.notices, iconUrl: 'chrome-extension://x/icons/icon-128.png' };
const notice = {
  id: 'told:12', title: 'Your video is ready', body: 'Three clips cut from Tuesday.', open: '/files', level: 'time-sensitive',
  actions: [{ id: 'reply', label: 'Reply', input: { placeholder: 'Tell your AI', button: 'Send' } }, { id: 'hand-to-ai', label: 'Hand to my AI' }, { id: 'snooze', label: 'Later' }],
};

test('a notice shows its words and its first two actions as buttons, by label', () => {
  const shown = notificationFor(notice, shape);
  assert.equal(shown.type, 'basic');
  assert.equal(shown.title, 'Your video is ready');
  assert.equal(shown.message, 'Three clips cut from Tuesday.');
  assert.deepEqual(shown.buttons, [{ title: 'Reply' }, { title: 'Hand to my AI' }]);
});

test('loudness is DATA: time-sensitive stays until dismissed at top priority, an unknown level is quiet', () => {
  assert.equal(notificationFor(notice, shape).requireInteraction, true);
  assert.equal(notificationFor(notice, shape).priority, 2);
  const quiet = notificationFor({ ...notice, level: 'nobody-named-this' }, shape);
  assert.equal(quiet.requireInteraction, false);
  assert.equal(quiet.priority, 0);
  assert.deepEqual(notificationFor({ id: 'told:1', title: 'Hi' }, shape).buttons, []);
});

test('the web push key decodes to the bytes it names, and equal keys compare equal', () => {
  const bytes = bytesFromBase64url('BAEC_-8');
  assert.deepEqual([...bytes], [4, 1, 2, 255, 239]);
  assert.equal(sameBytes(bytes.buffer, Uint8Array.of(4, 1, 2, 255, 239)), true);
  assert.equal(sameBytes(bytes, Uint8Array.of(4, 1, 2)), false);
  assert.equal(sameBytes(null, bytes), false);
});

test('the browser is named from the brands it reports, Brave by its own mark, else the DATA default', () => {
  const names = words.notices.browsers;
  assert.equal(browserLabel({ brands: [{ brand: 'Not_A Brand' }, { brand: 'Microsoft Edge' }] }, names), 'Edge');
  assert.equal(browserLabel({ brands: [{ brand: 'Chromium' }], brave: true }, names), 'Brave');
  assert.equal(browserLabel({ brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }] }, names), 'Chrome');
});

test('unread counts notices the person has not read', () => {
  assert.equal(unreadCount([{ read: false }, { read: true }, {}]), 2);
  assert.equal(unreadCount(undefined), 0);
});

test('the badge shows the first mark that says something, in the DATA order', () => {
  const marks = { recording: null, unread: 3, tray: 2 };
  assert.deepEqual(firstMark(settings.badge, name => marks[name]), { text: '3', color: 'accent-primary' });
  assert.deepEqual(firstMark(settings.badge, name => ({ ...marks, recording: 'REC' })[name]), { text: 'REC', color: 'color-error' });
  assert.deepEqual(firstMark(settings.badge, name => ({ unread: 0, tray: 2 })[name] ?? null), { text: '2', color: 'text-primary' });
  assert.equal(firstMark(settings.badge, () => null), null);
});

test('the badge draws in the look the person wears: each row names a colour of the worn look by its palette name', async () => {
  const stored = {};
  globalThis.chrome = { storage: { local: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, value) } } };
  const { keepWornLook, wornColor } = await import('../src/worn-look.mjs');
  for (const row of settings.badge) assert.equal((await wornColor(row.color))?.length, 4, `${row.mark} names a colour every look has`);
  const answer = { worn: 'mine', worn_record: { address: 'x', payload: { id: 'mine' } }, now: { colors: { 'accent-primary': [0, 1, 0, 1] } } };
  assert.equal(await keepWornLook(async () => answer), true);
  assert.deepEqual(await wornColor('accent-primary'), [0, 255, 0, 255]);
  assert.equal(await keepWornLook(async () => answer), false, 'the same look kept again changes nothing');
  delete globalThis.chrome;
});
