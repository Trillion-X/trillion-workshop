// The live-screens row runs the plain function runner on check-live-screens' export, in a container on this Mac like the given-pages
// check (the fetched headless shell, the files the export reads, the records door for the pictures' keep path). The window
// picture is not in this row: it is a separate computer row, because it needs the Mac's own window server.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:check-live-screens');
const signed = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:check-live-screens-signed-in');
const packed = package_ => row.invoke.files.package_files.find(files => files.package === package_)?.paths ?? [];

test('the live row runs checkLiveScreens through the plain function runner, in a container on this Mac', () => {
  assert.equal(row.invoke.kind, 'container');
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.invoke.argv[2], '/opt/check-every-screen-at-every-width/check-live-screens.mjs');
  assert.equal(row.invoke.argv[3], 'checkLiveScreens');
  assert.equal(row.invoke.programs['chrome-headless-shell'].fetch['macos-aarch64'].version, '153.0.8010.12');
});

test('the live row holds no key, so it reaches any public address, and takes no sign-in', () => {
  assert.equal(row.invoke.credential_mounts, undefined);
  assert.equal(row.invoke.internet, true);
  assert.equal(row.invoke.public_read, true);
  assert.equal(row.input_schema.properties.pages.items.properties.sign_in, undefined);
});

test('the signed-in row holds only the proof session on descriptor 4, and its sign_in carries no cookie', () => {
  assert.deepEqual(signed.invoke.credential_mounts, [{ secret_name: 'proof-sessions', fd: 4 }]);
  assert.equal(signed.invoke.public_read, undefined);
  assert.deepEqual(signed.input_schema.properties.pages.items.properties.sign_in.properties, { kind: { const: 'held-session' } });
  assert.deepEqual(signed.invoke.argv, row.invoke.argv);
  assert.deepEqual(signed.invoke.files, row.invoke.files);
});

test('the live row packs the DATA the check reads, the sign-in module and the pictures\' keep path, and no window picture', () => {
  assert.ok(packed('check-every-screen-at-every-width').includes('held-session.mjs'));
  assert.ok(!packed('check-every-screen-at-every-width').includes('email-code.mjs'));
  assert.ok(packed('check-every-screen-at-every-width').includes('live-screens.json'));
  assert.ok(!packed('check-every-screen-at-every-width').includes('window-picture.mjs'));
  assert.ok(packed('headless-browser').includes('admission.json'));
  assert.ok(packed('workflows').includes('read-data/whole-file.mjs'));
});

test('the live row takes the reach and until inputs and names its picture output', () => {
  assert.ok(row.input_schema.properties.pages.items.properties.reach);
  assert.equal(row.input_schema.properties.window, undefined);
});

test('the expiry row mounts the proof session, reaches nothing, and runs heldSessionExpiries', () => {
  const expiry = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:read-when-the-proof-session-ends');
  assert.deepEqual(expiry.invoke.credential_mounts, [{ secret_name: 'proof-sessions', fd: 4 }]);
  assert.equal(expiry.invoke.internet, false);
  assert.equal(expiry.invoke.argv[3], 'heldSessionExpiries');
});

test('every row that packs held-session.mjs packs the proof-accounts.json it reads', () => {
  for (const payload of rows.records.map(record => record.payload)) {
    const paths = payload.invoke.files.package_files.find(files => files.package === 'check-every-screen-at-every-width')?.paths ?? [];
    if (paths.includes('held-session.mjs')) assert.ok(paths.includes('proof-accounts.json'), payload.id);
  }
});

test('the three refresh rows hold only what their step needs: no key, the mailbox key, then the code and the sessions', () => {
  const of = id => rows.records.map(record => record.payload).find(payload => payload.id === id).invoke;
  const ask = of('tool:ask-the-proof-accounts-for-sign-in-codes');
  const keep = of('tool:keep-the-proof-accounts-sign-in-codes');
  const sign = of('tool:sign-the-proof-accounts-in-with-their-kept-codes');
  assert.equal(ask.credential_mounts, undefined);
  assert.equal(ask.records, undefined);
  assert.deepEqual(keep.credential_mounts, [{ secret_name: 'agentmail-api-key', fd: 4 }]);
  assert.deepEqual(keep.records.rights, [{ at: '@secrets', id: 'proof-sign-in-code', operations: ['secrets:put'] }]);
  assert.deepEqual(sign.credential_mounts, [{ secret_name: 'proof-sign-in-code', fd: 4 }, { secret_name: 'proof-sessions', fd: 5 }]);
  assert.deepEqual(sign.records.rights.map(right => right.id), ['proof-sign-in-code', 'proof-sessions']);
  assert.ok(sign.records.rights.every(right => right.at === '@secrets' && right.operations.join() === 'secrets:put'));
});
