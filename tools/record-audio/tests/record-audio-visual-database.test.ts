import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { foldAddressedDescriptorFacts } from 'trillion-workshop/tools/keep-lists-of-rows/read-data/addressed-descriptors.ts';
import { visualDatabaseInputsFromAddressedDescriptors } from 'trillion-workshop/tools/keep-lists-of-rows/read-data/descriptor-projection.ts';
import {
  decodeVisualDatabaseModel,
  projectVisualDatabaseView,
} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database.ts';
import {
  descriptorMigrationSemanticDigest,
  selectDescriptorAuthority,
} from 'trillion-workshop/tools/keep-lists-of-rows/do-work/migrate-descriptor-aggregates.ts';
import contract from '../things-to-store-and-run.json';

type Thing = Record<string, unknown>;
const things = (contract as { things: Thing[] }).things;
const target = {
  addressPrefix: 'visual-database.descriptors::record-audio',
  pathLabels: ['current-item', 'visual-database-descriptor', 'owner', 'record-audio'],
} as const;

function payloadKind(thing: Thing): string | undefined {
  const payload = thing.payload as { kind?: string } | undefined;
  return payload?.kind;
}

function addressedDescriptorTruth() {
  const descriptorThings = things.filter((thing) => payloadKind(thing) === 'visual-database.descriptor');
  const fold = foldAddressedDescriptorFacts(
    target,
    descriptorThings.map((thing, index) => ({
      addressLabel: thing.address as string,
      pathLabels: thing.path as readonly string[] | undefined,
      payload: thing.payload,
      payloadHash: Uint8Array.of((index % 255) + 1),
    })),
  );
  expect(fold.invalid).toEqual([]);
  const authority = things.find((thing) => thing.address === `${target.addressPrefix}::authority`)?.payload;
  expect(selectDescriptorAuthority({ activation: authority, target, fold })).toMatchObject({
    state: 'addressed',
  });
  const facts = descriptorThings.map((thing) => thing.payload);
  expect(authority).toMatchObject({
    active_address_prefix: target.addressPrefix,
    migration_receipt: {
      descriptor_count: facts.length,
      semantic_digest: descriptorMigrationSemanticDigest(facts),
      source_bases: [],
    },
  });
  return visualDatabaseInputsFromAddressedDescriptors(fold.snapshots);
}

const RECORDING_ROWS = [{
  id: 'recording:test',
  label: 'Desk recording',
  subtitle: 'Morning session',
  notes: 'Serve timing',
  mode: 'audio',
  mediaType: 'audio/webm',
  byteLength: 12,
  durationMs: 34000,
  recordedAt: '2026-09-03T10:00:00.000Z',
  state: 'stopped',
  error: '',
}];

function decodeRecordingModel() {
  const inputs = addressedDescriptorTruth();
  return {
    inputs,
    model: decodeVisualDatabaseModel({
      records: { records: RECORDING_ROWS },
      fields: inputs.fields,
      views: inputs.views,
      actions: { actions: [] },
    }),
  };
}

describe('record-audio visual database descriptors', () => {
  it('folds owned descriptor DATA into recording fields and views', () => {
    const { inputs, model } = decodeRecordingModel();
    expect(inputs.fields).toMatchObject({ kind: 'visual-database.fields', version: 3 });
    expect(inputs.views).toMatchObject({ kind: 'visual-database.views', version: 3 });
    expect(model.fields.map((field) => field.id)).toEqual([
      'recording-id',
      'recording-title',
      'recording-subtitle',
      'recording-notes',
      'recording-capture-kind',
      'recording-condition',
      'recording-state',
      'recording-error',
      'recording-media-type',
      'recording-byte-length',
      'recording-duration-ms',
      'recording-recorded-at',
      'recording-source',
      'recording-playback',
    ]);
    expect(model.views.map((view) => [view.id, view.kind])).toEqual([
      ['library-list', 'list'],
      ['library-board', 'board'],
      ['library-timeline', 'timeline'],
    ]);
  });

  it('projects a real recording row through the generic view primitive', () => {
    const { model } = decodeRecordingModel();
    const projection = projectVisualDatabaseView(model, { view: 'library-list' });
    expect(projection.rootKeys).toEqual(['recording:test']);
    const projected = projection.recordsByKey['recording:test'];
    expect(projected).toBeTruthy();
    expect(projected.id).toBe('recording:test');
    expect(projected.title).toBe('Desk recording');
    const fieldText = (fieldId: string) => projected.fields.find((field) => field.fieldId === fieldId)?.text;
    expect(fieldText('recording-recorded-at')).toEqual(['2026-09-03T10:00:00.000Z']);
    expect(fieldText('recording-media-type')).toEqual(['audio/webm']);
    expect(fieldText('recording-byte-length')).toEqual(['12']);
    expect(fieldText('recording-duration-ms')).toEqual(['34000']);
    expect(fieldText('recording-state')).toEqual(['stopped']);
  });

  it('derives presentation condition from a formula-engine binding', () => {
    const condition = things.find((thing) => thing.address === `${target.addressPrefix}::member::field::recording-condition`)?.payload as {
      value?: {
        defaultExpression?: {
          derive?: {
            target?: string;
            evaluator_ref?: string;
            request?: { binding?: unknown };
            result_path?: string[];
          };
        };
      };
    };
    expect(condition.value?.defaultExpression?.derive).toMatchObject({
      target: 'slot::formula-engine',
      evaluator_ref: 'evaluator::record-audio-recording-condition',
    });
    expect(condition.value?.defaultExpression?.derive?.request?.binding).toMatchObject({
      $kind: 'binding',
      select: { from: 'self' },
    });
    expect(condition.value?.defaultExpression?.derive?.result_path).toEqual(['value']);

    const evaluatorRecord = things.find((thing) => thing.address === 'package::record-audio::evaluator-descriptors')?.payload as {
      descriptors?: Array<{ ref?: string; target?: string }>;
    };
    expect(evaluatorRecord.descriptors).toEqual([
      expect.objectContaining({
        ref: 'evaluator::record-audio-recording-condition',
        target: 'slot::formula-engine',
        context_path: ['context'],
      }),
    ]);
  });

  it('preserves the manifest byte formatting under the canonical JSON settings', () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'things-to-store-and-run.json');
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text);
    expect(JSON.stringify(parsed, null, 2) + '\n').toBe(text);
  });
});
