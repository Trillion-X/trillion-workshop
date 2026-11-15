// The eligibility gate of a program row (parts/computer-programs/read-data/program-here.mjs): a hearing program that needs more than this Mac
// has is never chosen, and listening says why instead of just "no program".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gateOf, gateReasons, hearingHere, machineFacts } from 'trillion-workshop/tools/computer-programs/read-data/program-here.mjs';
import { rowOf } from 'trillion-workshop/tools/run-on-a-persons-computer/listen.mjs';

const rows = JSON.parse(readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/bring-in-new-items-from-this-computer/computer/computer-sources.json')), 'utf8'));
const mac = { arch: 'arm64', macos: '14.4', memory_gb: 16, free_disk_gb: 40 };
const can = { exists: () => true, run: () => {} };

test('a row with no needs is always eligible, and each unmet need is a plain reason', () => {
  assert.deepEqual(gateOf(undefined, mac), { ok: true, reasons: [] });
  assert.equal(gateOf({ arch: 'arm64', macos_min: '13.5', memory_gb: 8, free_disk_gb: 3 }, mac).ok, true);
  const small = gateOf({ arch: 'arm64', macos_min: '15', memory_gb: 32, free_disk_gb: 100 }, mac);
  assert.deepEqual(small.reasons, ['it needs macOS 15 or newer (this is 14.4)', 'it needs 32 GB of memory', 'it needs 100 GB free on the disk']);
  assert.equal(gateOf({ arch: 'arm64' }, { ...mac, arch: 'x64' }).ok, false);
  assert.equal(gateOf({ free_disk_gb: 1 }, { ...mac, free_disk_gb: null }).ok, false, 'a fact that cannot be read fails its need');
});

test('the shipped hearing row is gated, and the hearing lookup skips a row this Mac fails and says why', () => {
  const hearing = rows.hearing.find(row => row.id === 'mlx-whisper');
  assert.deepEqual(hearing.needs, { arch: 'arm64', macos_min: '13.5', memory_gb: 8, free_disk_gb: 3 });
  assert.ok(hearingHere([hearing], { ...can, facts: mac }), 'an eligible Mac finds it');
  const intel = { ...mac, arch: 'x64', memory_gb: 4 };
  assert.equal(hearingHere([hearing], { ...can, facts: intel }), null);
  assert.deepEqual(gateReasons([hearing], intel), ['mlx-whisper on this Mac: it needs arm64 (this is x64), it needs 8 GB of memory']);
  assert.deepEqual(gateReasons([hearing], mac), []);
  assert.equal(hearingHere([{ ...hearing, needs: undefined }], { ...can, facts: intel })?.id, 'mlx-whisper', 'with no needs the row is chosen as before');
});

test('this Mac\'s facts are read for real', () => {
  const facts = machineFacts();
  console.log('REAL readback of this Mac for the hearing gate:', JSON.stringify(facts));
  assert.ok(facts.memory_gb > 0 && ['arm64', 'x64'].includes(facts.arch));
  assert.ok(rowOf(rows).listen.words.no_hearing);
});
