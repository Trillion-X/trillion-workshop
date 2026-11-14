import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import manifest from '../things-to-store-and-run.json';
import {
  descriptorAuthorityActivationFromUnknown,
  descriptorMigrationSemanticDigest,
} from 'trillion-workshop/tools/keep-lists-of-rows/do-work/migrate-descriptor-aggregates.ts';
import {
  descriptorAddressFor,
  foldAddressedDescriptorFacts,
  type DescriptorFact,
} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/addressed-descriptors.ts';
import { visualDatabaseInputsFromAddressedDescriptors } from 'trillion-workshop/tools/keep-lists-of-rows/read-data/descriptor-projection.ts';
import { decodeVisualDatabaseEvaluatorDescriptors } from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database.ts';

const target = {
  addressPrefix: 'visual-database.descriptors::record-audio',
  pathLabels: ['current-item', 'visual-database-descriptor', 'owner', 'record-audio'],
};

type Thing = typeof manifest.things[number];

function descriptorThings(): Thing[] {
  return manifest.things.filter((thing) => (
    thing.type === 'record'
    && (thing.payload as { kind?: string } | null)?.kind === 'visual-database.descriptor'
  ));
}

describe('record-audio visual database ownership', () => {
  it('folds only recording segments so unrelated current records cannot erase the surface', () => {
    const aggregate = manifest.things.find((thing) => thing.address === 'record-audio-recordings-v2') as {
      matching_record_paths?: string[][];
      payload_bytes?: { group_by?: { path?: string[] } };
    } | undefined;
    expect(aggregate?.matching_record_paths).toEqual([['record-audio', 'media-record-segment']]);
    expect(aggregate?.payload_bytes?.group_by?.path).toEqual(['payload', 'record_id']);
  });

  it('round trips the manifest without formatting drift', () => {
    const original = readFileSync(new URL('../things-to-store-and-run.json', import.meta.url), 'utf8');
    const serialized = `${JSON.stringify(JSON.parse(original), null, 2)}\n`;
    expect(serialized).toBe(original);
  });

  it('seeds one valid addressed descriptor authority', () => {
    const things = descriptorThings();
    expect(things.length).toBe(23);
    const fold = foldAddressedDescriptorFacts(target, things.map((thing, index) => ({
      addressLabel: thing.address,
      pathLabels: thing.path,
      payload: thing.payload as DescriptorFact,
      payloadHash: Uint8Array.of((index % 255) + 1),
    })));
    expect(fold.invalid).toEqual([]);
    expect(fold.snapshots).toHaveLength(things.length);
    for (const thing of things) {
      const fact = thing.payload as DescriptorFact;
      expect(thing.address).toBe(descriptorAddressFor(target, fact.key));
    }

    const authority = manifest.things.find((thing) => thing.address === `${target.addressPrefix}::authority`);
    expect(authority).toBeTruthy();
    const activation = descriptorAuthorityActivationFromUnknown(authority?.payload);
    expect(activation?.migration_receipt.descriptor_count).toBe(things.length);
    expect(activation?.migration_receipt.semantic_digest).toBe(
      descriptorMigrationSemanticDigest(things.map((thing) => thing.payload as DescriptorFact)),
    );

    const projection = visualDatabaseInputsFromAddressedDescriptors(fold.snapshots);
    expect(projection.fields.descriptors.map((field: { id: string }) => field.id)).toContain('recording-condition');
    expect(projection.views.views.map((view: { id: string }) => view.id)).toEqual([
      'library-list',
      'library-board',
      'library-timeline',
    ]);
  });

  it('routes condition derivation through the shared Formula Engine binding contract', () => {
    const condition = descriptorThings().find((thing) => (
      (thing.payload as DescriptorFact).key.id === 'recording-condition'
    ));
    const conditionPayload = condition?.payload as DescriptorFact & {
      value: { defaultExpression?: { derive?: { target?: string; result_path?: string[]; request?: { binding?: unknown } } } };
    };
    const derive = conditionPayload?.value.defaultExpression?.derive;
    expect(derive?.target).toBe('slot::formula-engine');
    expect(derive?.result_path).toEqual(['value']);
    expect(derive?.request?.binding).toMatchObject({ $kind: 'binding' });

    const evaluatorThing = manifest.things.find((thing) => thing.address === 'package::record-audio::evaluator-descriptors');
    const evaluator = decodeVisualDatabaseEvaluatorDescriptors(evaluatorThing?.payload)[0];
    expect(evaluator).toMatchObject({
      ref: 'evaluator::record-audio-recording-condition',
      target: 'slot::formula-engine',
      contextPath: ['context'],
    });
  });
});
