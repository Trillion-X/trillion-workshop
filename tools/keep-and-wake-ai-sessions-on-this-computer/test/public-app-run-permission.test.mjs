import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedPublicRunPermission, publicRunEligible, publicRunPermissionFor } from '../src/public-app-run-permission.mjs';

const fieldNote = {
  id: 'tool:field-note', show_on_public_site: true,
  input_schema: { type: 'object', required: ['note'], properties: { note: { type: 'string', maxLength: 1200 } } },
  invoke: { kind: 'container', argv: ['python3', 'main.py', { from: 'note' }], stdout: 'json', files: '1f:4f54a70f996671f1f18c94f714235dff3e56d6aed1e58532dae61dc17fe4ef' },
};

test('public-run admission accepts a bounded safe container with the real default workdir', () => {
  assert.equal(publicRunEligible(fieldNote), true);
  assert.deepEqual(checkedPublicRunPermission({ runs_per_day: 10, max_input_bytes: 2048 }), { runs_per_day: 10, max_input_bytes: 2048 });
  assert.deepEqual(publicRunPermissionFor({ ...fieldNote, public_run: { runs_per_day: 10 } }), { runs_per_day: 10, max_input_bytes: 16_384 });
});

test('public-run admission rejects unbounded or externally effective tools', () => {
  for (const permission of [{ runs_per_day: 0 }, { runs_per_day: 101 }, { runs_per_day: 5, max_input_bytes: 16_385 }, { runs_per_day: 5, max_input_bytes: 0 }]) {
    assert.throws(() => checkedPublicRunPermission(permission));
  }
  for (const tool of [
    { ...fieldNote, invoke: { ...fieldNote.invoke, internet: true } },
    { ...fieldNote, invoke: { ...fieldNote.invoke, workdir: '/tmp' } },
    { ...fieldNote, invoke: { ...fieldNote.invoke, credential_injections: [{ secret_name: 'service-key' }] } },
    { ...fieldNote, invoke: { ...fieldNote.invoke, external_effect: { kind: 'send' } } },
    { ...fieldNote, invoke: { ...fieldNote.invoke, outputs: [{ name: 'result', path: '/work/out.txt' }] } },
    { ...fieldNote, needs: { secret_names: ['service-key'] } },
    { ...fieldNote, keeps_records: [{ output_selector: '$', type_field: 'type', id_field: 'id' }] },
    { ...fieldNote, price_ref: 'offer:paid' },
  ]) assert.equal(publicRunEligible(tool), false);
});
