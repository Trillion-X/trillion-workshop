// The mail screens know no provider: the provider rows (tools/read-and-write-mail/read-data/mail-providers.json) are the
// only place a provider's name, connection kind, host or wire words are written. A screen shows the row's label, takes its
// web links and connect address from it, and calls the mail tools by job name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const providers = JSON.parse(read('../../read-and-write-mail/read-data/mail-providers.json')).providers;
const words = providers.flatMap(row => [row.id, row.label, row.connection_vendor, ...row.hosts, 'Google account']).map(word => word.toLowerCase());
const wire = ['payload.parts', 'labelIds', 'sendAs', 'internalDate', 'gmailRawMessage', 'base64url', 'metadataHeaders'];
const screens = [
  '../web/src/workspace/mail-message.ts', '../web/src/workspace/mail-accounts.ts', '../web/src/workspace/mail-settings.tsx', '../web/src/workspace/mail-settings.json',
  '../web/src/workspace/sharing-sheet.tsx', '../web/src/workspace/note-share.json',
  '../../calendar/web/src/workspace/email-screen.tsx', '../../calendar/web/src/workspace/mail-action-bar.tsx', '../../calendar/web/src/workspace/mail-actions.json',
];

test('no mail screen names a provider, its connection kind, its host or its wire words', () => {
  for (const path of screens) {
    const text = read(path).toLowerCase();
    for (const word of words) assert.ok(!text.includes(word), `${path} names ${word}`);
    for (const word of wire) assert.ok(!text.includes(word.toLowerCase()), `${path} reads the wire word ${word}`);
  }
});

test('the mail screens call the mail tools by job name, and every tool they call is a tool of the mail tools folder', () => {
  const rows = JSON.parse(read('../../read-and-write-mail/tool-rows.json')).records.map(record => record.payload.id);
  const called = new Set();
  for (const path of screens.filter(path => path.endsWith('.tsx'))) for (const [, id] of read(path).matchAll(/'(tool:[a-z-]+)'/g)) called.add(id);
  assert.ok(called.size >= 10);
  for (const id of called) assert.ok(rows.includes(id), `${id} is not a mail tool`);
});
