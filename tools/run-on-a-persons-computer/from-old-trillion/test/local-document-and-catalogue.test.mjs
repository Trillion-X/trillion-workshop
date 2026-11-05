// test/local-document-and-catalogue.test.mjs: versioned document with backup and evidence (F-0870), reference-vs-copy bindings with known-vs-active (F-0537, F-0780), seed plus override layers (F-0539), one-primary sessions (F-0570).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDocument } from '../../versioned-document.mjs';
import { apply, newSession } from '../../../media-composition/read-data/session-pairing.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'doc-'));

test('a document stores entries with their evidence, migrates with a backup, and refuses a newer or damaged file untouched', () => {
  const file = join(folder(), 'profile.json');
  const v1 = openDocument({ file, version: 1, now: () => Date.parse('2026-10-19T00:00:00Z') });
  assert.throws(() => v1.set('tone', 'plain', ' '), /needs the evidence/);
  v1.set('tone', 'plain', 'message m-12');
  const migrations = { 1: doc => ({ ...doc, entries: Object.fromEntries(Object.entries(doc.entries).map(([k, e]) => [k, { ...e, value: { text: e.value } }])) }) };
  const v2 = openDocument({ file, version: 2, migrations });
  assert.deepEqual(v2.get('tone').value, { text: 'plain' });
  assert.equal(v2.get('tone').evidence, 'message m-12');
  assert.equal(JSON.parse(readFileSync(`${file}.v1.bak`, 'utf8')).version, 1, 'the old file was copied first');
  assert.throws(() => openDocument({ file, version: 1 }).read(), error => error.status === 409 && /newer than this program/.test(error.message));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2, 'a newer file is not rewritten');
  const broken = join(folder(), 'x.json'); writeFileSync(broken, '{nope');
  assert.throws(() => openDocument({ file: broken, version: 1 }).read(), /not readable JSON/);
  assert.equal(readFileSync(broken, 'utf8'), '{nope');
  const stuck = join(folder(), 's.json'); writeFileSync(stuck, JSON.stringify({ version: 1, entries: {} }));
  assert.throws(() => openDocument({ file: stuck, version: 3, migrations: { 1: d => d } }).read(), /No migration from version 2/);
  assert.equal(existsSync(`${stuck}.v1.bak`), true);
});

test('devices share one session id and one primary; wrong-session, unknown-device and rule-breaking messages are ignored with a reason', () => {
  let s = newSession('S1', ['idle', 'recording']);
  const send = message => { const r = apply(s, message); s = r.session; return r.ignored?.reason; };
  assert.equal(send({ session: 'S1', type: 'join', device: 'cam1', role: 'primary' }), undefined);
  assert.equal(send({ session: 'S1', type: 'join', device: 'cam2' }), undefined);
  assert.equal(send({ session: 'S1', type: 'join', device: 'cam3', role: 'primary' }), 'primary_taken');
  assert.equal(send({ session: 'OTHER', type: 'state', device: 'cam1', state: 'recording' }), 'other_session');
  assert.equal(send({ session: 'S1', type: 'state', device: 'ghost', state: 'recording' }), 'unknown_device');
  assert.equal(send({ session: 'S1', type: 'state', device: 'cam2', state: 'flying' }), 'unknown_state');
  assert.equal(send({ session: 'S1', type: 'state', device: 'cam2', state: 'recording' }), undefined);
  assert.equal(s.devices.cam2.state, 'recording');
  assert.equal(send({ session: 'S1', type: 'handover', device: 'cam2', from: 'cam2' }), 'not_primary');
  assert.equal(send({ session: 'S1', type: 'handover', device: 'cam2', from: 'cam1' }), undefined);
  assert.equal(s.primary, 'cam2');
  assert.equal(send({ session: 'S1', type: 'leave', device: 'cam2' }), undefined);
  assert.equal(s.primary, null);
  assert.equal(send({ session: 'S1', type: 'dance', device: 'cam1' }), 'unknown_type');
});
