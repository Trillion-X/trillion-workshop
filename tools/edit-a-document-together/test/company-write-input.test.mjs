import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeScreenInput } from '../show/write-screen-input.mjs';
import settings from '../show/write-screen.json' with { type: 'json' };
const owner = { sharedPlace: settings.shared_place, sharedScene: settings.shared_scene };

test('company Write uses the existing shared room consistently across accounts', () => {
  const a = writeScreenInput({ space_id: 'membership_company', member_id: 'avery' }, owner);
  const b = writeScreenInput({ space_id: 'membership_company', member_id: 'rowan' }, owner);
  assert.equal(a.scene_address, 'space-room:membership_company/package::documents::documents');
  assert.equal(a.scene_address, b.scene_address);
  assert.notEqual(a.scene_address, writeScreenInput({ space_id: 'membership_another' }, owner).scene_address);
});

test('personal Write keeps its existing default and explicit document addresses', () => {
  assert.deepEqual(writeScreenInput({}, owner), {});
  const input = { scene_address: 'package::documents::documents::personal', one_page: true };
  assert.deepEqual(writeScreenInput(input, owner), input);
  assert.notEqual(writeScreenInput(input, owner), input);
});

test('company Write retains its exact shared board document', () => {
  const input = { space_id: 'membership_company', scene_address: 'space-room:membership_company/board-document:note', one_page: true };
  assert.deepEqual(writeScreenInput(input, owner), input);
});

test('malformed or mismatched company inputs never fall back to private pages', () => {
  for (const space_id of ['', '  ', 42, {}, 'a/b']) assert.throws(() => writeScreenInput({ space_id }, owner));
  for (const scene_address of ['package::documents::documents', 'space-room:other/document', 'space-room:membership_company/', 4, null]) {
    assert.throws(() => writeScreenInput({ space_id: 'membership_company', scene_address }, owner));
  }
});
