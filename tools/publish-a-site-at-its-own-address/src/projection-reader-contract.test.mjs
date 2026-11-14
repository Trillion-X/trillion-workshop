import assert from 'node:assert/strict';
import { buildReaderContract, assertSameProjectionForPlatforms, lastExternalAddress } from './projection-reader-contract.mjs';

const rows = [
  {
    kind: 'projection-row',
    projection_ref: 'projection:public-site-publisher.reader',
    subject_ref: 'record/public-site-publisher/site/1',
    field_roles: [
      { role: 'title', field_ref: 'field:title', value: 'Reference site' },
      { role: 'external_address', field_ref: 'field:external-address', value: 'https://example.test/site' },
    ],
    action_roles: [
      { role: 'primary_action', action_ref: 'action:public-site-publisher.request-content-update' },
      { role: 'preview_action', action_ref: 'action:public-site-publisher.request-preview' },
    ],
    view_roles: [{ role: 'history', relation_ref: 'relation:effects' }],
    history: [
      {
        kind: 'effect-receipt',
        ok: true,
        fields: { external_address: 'https://example.test/site' },
      },
      {
        kind: 'effect-receipt',
        ok: false,
        fields: { external_address: '' },
      },
    ],
  },
];

function runUnit() {
  const contract = buildReaderContract(rows, 'react-desktop-browser');
  assert.equal(contract.rows.length, 1);
  assert.equal(contract.rows[0].fields.title.value, 'Reference site');
  assert.equal(contract.rows[0].actions.length, 2);
  assert.equal(contract.invokeShape.kind, 'owner-action-intent');
  assert.equal(lastExternalAddress(contract.rows[0]), 'https://example.test/site');
  console.log('[public-site-publisher] projection reader contract ok');
}

function runAdversarial() {
  const alternateRows = structuredClone(rows);
  alternateRows[0].field_roles[0].value = 'Any label from data';
  alternateRows[0].action_roles[0].action_ref = 'action:any-owner-any-label';
  const contract = buildReaderContract(alternateRows, 'ios-jscore');
  assert.equal(contract.rows[0].fields.title.value, 'Any label from data');
  assert.equal(contract.rows[0].actions[0].actionRef, 'action:any-owner-any-label');
  assert.equal(JSON.stringify(contract).includes('vercel'), false);
  assert.equal(JSON.stringify(contract).includes('deployment'), false);
  console.log('[public-site-publisher] projection adversarial data labels ok');
}

function runPlatforms() {
  const { react, ios } = assertSameProjectionForPlatforms(rows);
  assert.deepEqual(react.rows, ios.rows);
  console.log('[public-site-publisher] projection platform parity ok');
}

const mode = process.argv.slice(2).find((arg) => arg.startsWith('--')) ?? '--unit';
if (mode === '--unit') runUnit();
else if (mode === '--adversarial') runAdversarial();
else if (mode === '--platforms') runPlatforms();
else throw new Error(`unknown mode ${mode}`);
