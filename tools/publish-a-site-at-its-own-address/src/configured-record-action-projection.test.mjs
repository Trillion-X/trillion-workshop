import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  effectReceipt,
  foldSubjectProjection,
  objectList,
  projectRows,
  recordEvent,
  validateConfiguredRecordActionProjection,
} from './configured-record-action-projection.mjs';

const contract = JSON.parse(readFileSync(new URL('../things-to-store-and-run.json', import.meta.url), 'utf8'));
const config = contract.things.find((thing) => thing.address === 'public-site-publisher.configured-record-action-projection').payload;
const descriptor = config.projection_descriptors[0];

function runContract() {
  const result = validateConfiguredRecordActionProjection(config);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(config.kind, 'configured-record-action-projection');
  assert.equal(objectList(config.action_bindings).every((action) => action.target === 'slot::workflow'), true);
  assert.equal(JSON.stringify(contract).includes('PublicationAttemptLog'), false);
  assert.equal(JSON.stringify(contract).includes('PublicWebsiteProjection'), false);
  console.log('[public-site-publisher] generic record/action/projection contract ok');
}

function runUnit() {
  const subjectRef = 'record/public-site-publisher/site/unit';
  const created = recordEvent({
    subjectRef,
    eventRole: 'package-data/public-site-publisher/event-roles/create-subject',
    fieldFacts: {
      title: 'Demo site',
      external_address: 'https://example.test/current',
    },
  });
  const change = recordEvent({
    subjectRef,
    eventRole: 'package-data/public-site-publisher/event-roles/request-update',
    fieldFacts: {
      selected_content: 'content:demo',
    },
    correlationRef: 'correlation:update',
  });
  const failed = effectReceipt({
    correlationRef: 'correlation:update',
    effectRole: 'package-data/public-site-publisher/effect-roles/update-result',
    ok: false,
    fields: {
      external_address: '',
      last_successful_effect: 'effect:prior-live',
    },
    errorRef: 'error:update',
    processSessionRef: 'process_session:update',
  });
  const [subject] = foldSubjectProjection([created, change], [failed], config);
  assert.equal(subject.fields.title, 'Demo site');
  assert.equal(subject.fields.selected_content, 'content:demo');
  assert.equal(subject.fields.external_address, 'https://example.test/current');
  assert.equal(subject.fields.last_successful_effect, 'effect:prior-live');

  const [row] = projectRows([subject], descriptor);
  assert.equal(row.kind, 'projection-row');
  assert.equal(row.field_roles.find((role) => role.role === 'external_address').value, 'https://example.test/current');
  console.log('[public-site-publisher] configured projection fold ok');
}

function runAdversarial() {
  const one = recordEvent({
    subjectRef: 'record/a',
    eventRole: 'role/create',
    fieldFacts: { title: 'A' },
  });
  const two = recordEvent({
    subjectRef: 'record/a',
    eventRole: 'role/update',
    fieldFacts: { selected_content: 'content:a' },
    correlationRef: 'correlation:a',
  });
  const other = recordEvent({
    subjectRef: 'record/b',
    eventRole: 'role/create',
    fieldFacts: { title: 'B', external_address: 'https://b.example.test' },
    correlationRef: 'correlation:b',
  });
  const ok = effectReceipt({
    correlationRef: 'correlation:a',
    effectRole: 'package-data/public-site-publisher/effect-roles/preview-result',
    ok: true,
    fields: { last_render_ref: 'render:a' },
    processSessionRef: 'process_session:a',
  });
  const retryAfterFailure = effectReceipt({
    correlationRef: 'correlation:b',
    effectRole: 'package-data/public-site-publisher/effect-roles/live-result',
    ok: false,
    fields: { external_address: '' },
    errorRef: 'error:b',
  });

  const subjects = foldSubjectProjection([one, two, other], [ok, retryAfterFailure], config);
  assert.equal(subjects.length, 2);
  assert.equal(subjects.find((entry) => entry.subject_ref === 'record/a').fields.last_render_ref, 'render:a');
  assert.equal(subjects.find((entry) => entry.subject_ref === 'record/b').fields.external_address, 'https://b.example.test');

  const rowsA = projectRows(subjects, descriptor);
  const rowsB = projectRows(subjects, { ...descriptor, id: 'projection:alternate-reader' });
  assert.equal(rowsA.length, rowsB.length);
  assert.equal(rowsB[0].projection_ref, 'projection:alternate-reader');
  console.log('[public-site-publisher] l069 closure ok');
}

const mode = process.argv.slice(2).find((arg) => arg.startsWith('--')) ?? '--unit';
if (mode === '--unit') runUnit();
else if (mode === '--adversarial') runAdversarial();
else if (mode === '--contract') runContract();
else throw new Error(`unknown mode ${mode}`);
