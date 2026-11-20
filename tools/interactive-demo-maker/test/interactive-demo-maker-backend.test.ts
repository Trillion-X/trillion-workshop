import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  descriptorSetFromRows,
  materializeStructuredProposalRows,
  readConfiguredRecordWorkspace,
  type ActionDescriptor,
  type AddressedRecordRow,
  type DescriptorSet,
} from '../read-data/configured-record-workspace.ts';
import {
  buildConfiguredRecordWorkspaceActionRequest,
  buildConfiguredRecordWorkspaceRequestByDescriptorId,
} from '../do-work/configured-record-workspace-actions.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(root, 'things-to-store-and-run.json'), 'utf8')) as {
  things: { type: string; address: string; payload: Record<string, unknown> }[];
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|json|md)$/.test(name) ? [path] : [];
  });
}

function backendSourceFiles(): string[] {
  return [
    join(root, 'things-to-store-and-run.json'),
    join(root, 'read-data'),
    join(root, 'do-work'),
  ].flatMap((path) => statSync(path).isDirectory() ? sourceFiles(path) : [path]);
}

function payloadAt(address: string): Record<string, unknown> {
  const thing = contract.things.find((entry) => entry.address === address);
  assert.ok(thing, `missing contract thing ${address}`);
  return thing.payload;
}

function descriptorRows(): AddressedRecordRow[] {
  return contract.things
    .filter((entry) => entry.type === 'record')
    .map((entry) => ({ address: entry.address, payload: entry.payload }));
}

function descriptors(): Required<DescriptorSet> {
  const fromRows = descriptorSetFromRows(descriptorRows());
  return {
    fields: fromRows.fields ?? [],
    relationships: fromRows.relationships ?? [],
    views: fromRows.views ?? [],
    actions: fromRows.actions ?? [],
    rules: fromRows.rules ?? [],
  };
}

describe('interactive-demo-maker backend descriptors', () => {
  it('declares a configured record workspace and no new slot', () => {
    const capability = payloadAt('package::interactive-demo-maker::capability::configured-record-workspace');
    assert.equal(capability.kind, 'bitfield-package-capability');
    assert.equal(capability.new_slot, false);
    const reuses = capability.reuses as string[];
    for (const name of [
      'record-video',
      'audio-transcription',
      'media-analysis',
      'media-composition',
      'content-media-evidence',
      'workflow',
      'process-session',
      'stored_bytes',
      'record_from_matching_records',
    ]) {
      assert.ok(reuses.includes(name), `capability reuses ${name}`);
    }

    assert.equal(payloadAt('package::interactive-demo-maker::fields::workspace').kind, 'configured-record-workspace.field-descriptors');
    assert.equal(payloadAt('package::interactive-demo-maker::actions::workspace').kind, 'configured-record-workspace.action-descriptors');
  });

  it('uses the same descriptor primitive for walkthrough-shaped and non-walkthrough-shaped profiles', () => {
    const set = descriptors();
    const walkthrough = readConfiguredRecordWorkspace({
      descriptors: set,
      records: [
        {
          ref: 'record:walkthrough',
          title: 'Product overview',
          role: 'workspace',
          relationships: [{ role: 'ordered-items', to_ref: 'record:walkthrough:1', order: 1 }],
          source_refs: ['source:recording'],
        },
        {
          ref: 'record:walkthrough:1',
          title: 'Open dashboard',
          role: 'item',
          position: 1,
          field_values: { viewer_instruction: 'Open dashboard' },
        },
      ],
      source_material: [{ ref: 'source:recording', label: 'Screen recording', owner_ref: 'record-video' }],
    });
    const relationshipWork = readConfiguredRecordWorkspace({
      descriptors: set,
      records: [
        {
          ref: 'record:relationship-work',
          title: 'Account review',
          role: 'workspace',
          relationships: [{ role: 'ordered-items', to_ref: 'record:relationship-work:1', order: 1 }],
          source_refs: ['source:conversation'],
        },
        {
          ref: 'record:relationship-work:1',
          title: 'Send next message',
          role: 'item',
          position: 1,
          field_values: { viewer_instruction: 'Send next message' },
        },
      ],
      source_material: [{ ref: 'source:conversation', label: 'Conversation', owner_ref: 'outside-conversations' }],
    });

    assert.equal(walkthrough.records.length, 2);
    assert.equal(relationshipWork.records.length, 2);
    assert.deepEqual(walkthrough.proof.descriptor_counts, relationshipWork.proof.descriptor_counts);
    assert.equal(walkthrough.actions.find((action) => action.id === 'publish-handoff')?.blocked, false);
    assert.equal(relationshipWork.actions.find((action) => action.id === 'publish-handoff')?.blocked, false);
  });

  it('blocks an address handoff with the rule label when no record has the ordered-items relationship', () => {
    const model = readConfiguredRecordWorkspace({
      descriptors: descriptors(),
      records: [{ ref: 'record:bare', title: 'Bare draft', role: 'workspace' }],
    });
    const publish = model.actions.find((action) => action.id === 'publish-handoff');
    assert.equal(publish?.blocked, true);
    assert.equal(publish?.blocked_reason, 'Add at least one viewer-visible step before publishing.');
    assert.equal(model.actions.find((action) => action.id === 'preview-workspace')?.blocked, false);
  });

  it('keeps owner boundaries as address references instead of lower-owner imports or claims', () => {
    const factflow = payloadAt('package::interactive-demo-maker::factflow::surface');
    const capability = payloadAt('package::interactive-demo-maker::capability::configured-record-workspace');
    assert.equal(factflow.new_slot, false);
    assert.equal(factflow.execution_locus, 'slot::workflow');
    const owned = capability.owned_record_kinds as string[];
    for (const kind of [
      'recording',
      'transcription',
      'media-analysis',
      'media-composition',
      'publisher',
      'mail',
      'calendar',
      'provider',
      'campaign',
    ]) {
      assert.ok(!owned.includes(kind), `capability does not own ${kind}`);
    }

    const sourceText = backendSourceFiles()
      .map((file) => `${relative(root, file)}\n${readFileSync(file, 'utf8')}`)
      .join('\n');
    assert.doesNotMatch(sourceText, /from ['"].*\/(record-audio|record-video|audio-transcription|media-analysis|media-composition|workflow|process-session|content-media-evidence)/);
    assert.doesNotMatch(sourceText, /\b(new .*Slot|implements Slot|InteractiveDemoGraph|DemoStep|StepType|DemoStatus|PublishDestination|AnalysisSuggestionKind)\b/);
  });

  it('routes local writes and workflow work through action descriptors', () => {
    const set = descriptors();
    const actions = set.actions as ActionDescriptor[];
    const createRequest = buildConfiguredRecordWorkspaceRequestByDescriptorId('create-workspace-record', {
      operation_id: 'op:create',
      record_ref: 'record:new',
      field_values: { title: 'Draft' },
      descriptors: actions,
    });
    assert.equal(createRequest.target, 'engine.operation.write-batch');
    assert.equal(createRequest.payload.operation, 'record.write-batch');
    const operations = createRequest.payload.operations as Record<string, unknown>[];
    assert.equal(operations.length, 1);
    assert.equal(operations[0].kind, 'configured-record-workspace.operation');
    assert.equal(operations[0].record_ref, 'record:new');

    const processAction = actions.find((action) => action.id === 'request-structured-proposals');
    assert.ok(processAction);
    const processRequest = buildConfiguredRecordWorkspaceActionRequest({
      ...processAction,
      lookup: {
        operation_id: 'op:process',
        record_ref: 'record:new',
      },
    });
    assert.equal(processRequest.target, 'slot::workflow');
    assert.equal(processRequest.payload.operation, 'execute_definition');
    assert.equal(processRequest.payload.definition_id, 'content-media-evidence.request-structured-record-proposals');
    assert.equal(processRequest.payload.include_steps, false);
    assert.equal(processRequest.payload.include_output, false);
  });

  it('refuses an unknown descriptor id and a lookup without an operation id', () => {
    assert.throws(
      () => buildConfiguredRecordWorkspaceRequestByDescriptorId('no-such-action', { operation_id: 'op:x', descriptors: [] }),
      /Missing action descriptor: no-such-action/,
    );
    assert.throws(
      () => buildConfiguredRecordWorkspaceActionRequest({ id: 'create-workspace-record', lookup: { operation_id: '' } }),
      /operation_id is required/,
    );
  });

  it('materializes structured process rows without text parsing or profile branches', () => {
    const proposals = materializeStructuredProposalRows([
      {
        record_ref: 'record:walkthrough:1',
        field_values: { title: 'Open dashboard' },
        relationships: [{ role: 'ordered-items', to_ref: 'record:walkthrough:1', order: 1 }],
        source_refs: ['source:recording'],
        confidence: 0.92,
        rule_ref: 'has-viewer-visible-item',
        profile_ref: 'structured-record-proposals',
      },
      {
        record_ref: 'record:relationship-work:1',
        field_values: { title: 'Send next message' },
        relationships: [{ role: 'ordered-items', to_ref: 'record:relationship-work:1', order: 1 }],
        source_refs: ['source:conversation'],
        confidence: 0.87,
        rule_ref: 'has-viewer-visible-item',
        profile_ref: 'structured-record-proposals',
      },
    ]);
    assert.equal(proposals.length, 2);
    assert.deepEqual(proposals.map((proposal) => proposal.profile_ref), [
      'structured-record-proposals',
      'structured-record-proposals',
    ]);
  });

  it('drops proposal rows without a record reference and gives unnamed proposals a positional ref', () => {
    const proposals = materializeStructuredProposalRows([
      { record_ref: '', field_values: { title: 'No target' } },
      'not a row',
      null,
      { record_ref: 'record:a', field_values: { title: 'Kept' }, source_refs: 'not-a-list' },
    ]);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].ref, 'proposal:record:a:3');
    assert.deepEqual(proposals[0].source_refs, []);
  });

  it('reads records sorted by order, the selected record, proposals and proof counts from the same descriptors', () => {
    const model = readConfiguredRecordWorkspace({
      descriptors: descriptors(),
      records: [
        { ref: 'record:one', title: 'One', order: 2 },
        { ref: 'record:two', title: 'Two', order: 1 },
      ],
      selected_ref: 'record:one',
      proposals: [{ record_ref: 'record:two', field_values: { title: 'Proposed' } }],
      issues: ['needs a source'],
    });
    assert.deepEqual(model.records.map((record) => record.ref), ['record:two', 'record:one']);
    assert.equal(model.selected?.ref, 'record:one');
    assert.equal(model.proposals.length, 1);
    assert.deepEqual(model.issues, ['needs a source']);
    assert.equal(model.proof.source_record_count, 2);
    assert.equal(model.proof.proposal_count, 1);
    assert.equal(model.proof.selected_ref, 'record:one');
    assert.equal(model.view.id, 'workspace');
    assert.equal(model.empty.title, 'No demos yet');
    assert.deepEqual(model.empty.actions, ['start-recording', 'use-existing-source', 'start-from-screenshots']);
  });

  it('reads an empty workspace with the fallback view and empty title', () => {
    const model = readConfiguredRecordWorkspace({});
    assert.equal(model.view.id, 'workspace');
    assert.equal(model.empty.title, 'No records yet');
    assert.equal(model.selected, null);
    assert.equal(model.proof.selected_ref, null);
  });

  it('keeps a descriptor row only when its kind is in the DATA table, and never reads inherited keys', () => {
    const set = descriptorSetFromRows([
      { payload: { kind: 'constructor', descriptors: [{ id: 'x', label: 'X' }] } },
      { payload: { kind: 'configured-record-workspace.process-profiles', profiles: [] } },
    ]);
    assert.deepEqual(Object.keys(set), []);

    const fields = descriptorSetFromRows(descriptorRows()).fields ?? [];
    const contractFields = payloadAt('package::interactive-demo-maker::fields::workspace').descriptors as unknown[];
    assert.equal(fields.length, contractFields.length);
  });

  it('projects empty, sparse, dense, loading, error, proposal, desktop, mobile, and ios states from the same surface contract', () => {
    const set = descriptors();
    assert.equal(readConfiguredRecordWorkspace({ descriptors: set }).state, 'empty');
    assert.equal(readConfiguredRecordWorkspace({ descriptors: set, process_state: 'loading' }).state, 'loading');
    assert.equal(readConfiguredRecordWorkspace({ descriptors: set, issues: ['failed'] }).state, 'error');
    assert.equal(readConfiguredRecordWorkspace({
      descriptors: set,
      proposals: [{ record_ref: 'record:proposal', field_values: { title: 'Proposed' } }],
    }).state, 'proposal-ready');
    assert.equal(readConfiguredRecordWorkspace({
      descriptors: set,
      records: [{ ref: 'record:one', title: 'One' }],
    }).state, 'sparse');
    assert.equal(readConfiguredRecordWorkspace({
      descriptors: set,
      records: Array.from({ length: 30 }, (_, index) => ({ ref: `record:${index}`, title: `Record ${index}`, order: index })),
    }).state, 'dense');
    assert.equal(readConfiguredRecordWorkspace({ descriptors: set, reader_key: 'desktop' }).reader_key, 'desktop');
    assert.equal(readConfiguredRecordWorkspace({ descriptors: set, reader_key: 'mobile' }).reader_key, 'mobile');
    assert.equal(readConfiguredRecordWorkspace({ descriptors: set, reader_key: 'ios-jscore' }).reader_key, 'ios-jscore');
    assert.equal(readConfiguredRecordWorkspace({ descriptors: set }).reader_key, 'browser');
  });
});
