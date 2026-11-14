// packages/vision-board/show/action-affordance-records.test.ts
//
// Conformance: the action-affordance records SHIPPED in this package's manifest
// decode through the shared reader and map onto board shelf tools — the DATA
// twin of the deleted VISION_TOOL/BREAKDOWN_TOOL source constants.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readActionAffordances, affordancesForChannel } from '@/packages/ui/show/action-affordance';
import type { PublishedRecord } from '@/packages/ui/show/placeable-surface-intent/placeable-surface-record';
import { affordanceShelfTools, producerDescriptorOf } from '@/packages/group/show/board-action-affordances';

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'things-to-store-and-run.json'), 'utf8'),
) as { things: Array<{ type: string; address: string; path: string[]; payload: unknown }> };

const published: PublishedRecord[] = manifest.things
  .filter((t) => t.type === 'record')
  .map((t, i) => ({ recordId: t.address ?? `r${i}`, path: t.path ?? [], payload: t.payload, row: {} }));

describe('vision-board manifest action-affordance records', () => {
  const rows = readActionAffordances(published);

  it('ships Break down and Vision as records', () => {
    expect(rows.map((r) => r.label).sort()).toEqual(['Break down', 'Vision']);
  });

  it('both bind the board shelf channel AND the composition slash channel (package-agnostic)', () => {
    expect(affordancesForChannel(rows, 'group.add-shelf')).toHaveLength(2);
    expect(affordancesForChannel(rows, 'composition.slash-menu')).toHaveLength(2);
  });

  it('both bind the board palette + right-click channels (every board door)', () => {
    expect(affordancesForChannel(rows, 'group.palette')).toHaveLength(2);
    expect(affordancesForChannel(rows, 'group.context-menu')).toHaveLength(2);
  });

  it('board tools reproduce the deleted source constants exactly', () => {
    const tools = affordanceShelfTools(rows);
    const breakdown = tools.find((t) => t.label === 'Break down');
    const vision = tools.find((t) => t.label === 'Vision');
    expect(breakdown).toMatchObject({
      kind: 'pending',
      addStrategy: 'produce',
      defaultText: 'What goal do you want to break into steps?',
      totalHint: 6,
      workingLabel: 'Breaking this down…',
    });
    expect(vision).toMatchObject({ totalHint: 8, workingLabel: 'Envisioning…' });
    // producerDescriptorOfTrigger (board-action-affordances.ts) carries BOTH the
    // literal-only baseInput AND the raw inputTemplate (bindings + literals) —
    // the template is what lets the panel re-resolve `typed.text` against the
    // live selection at run time (see board-action-affordances.test.ts:78-94,
    // the sibling package's own conformance test for this exact same shape).
    expect(breakdown?.producer).toEqual({
      definitionId: 'action:run-ai-records-production',
      resultAddressTemplate: 'package::ai-records-producer::result::{id}',
      errorAddressTemplate: 'package::ai-records-producer::error::{id}',
      addressMode: 'label-hash',
      resultPartitionLabel: 'runtime-partition',
      baseInput: { output_kind: 'note', wrap_instruction_ref: 'instr:breakdown' },
      inputTemplate: {
        request_id: { $kind: 'binding', select: { from: 'run', path: 'id' } },
        target_group_ref: { $kind: 'binding', select: { from: 'surface', path: 'target_ref' } },
        instruction_text: { $kind: 'binding', select: { from: 'typed', path: 'text' } },
        output_kind: 'note',
        wrap_instruction_ref: 'instr:breakdown',
      },
    });
    expect(vision?.producer?.baseInput).toEqual({ output_kind: 'note', wrap_instruction_ref: 'instr:vision-board' });
    expect(vision?.producer?.inputTemplate).toEqual({
      request_id: { $kind: 'binding', select: { from: 'run', path: 'id' } },
      target_group_ref: { $kind: 'binding', select: { from: 'surface', path: 'target_ref' } },
      instruction_text: { $kind: 'binding', select: { from: 'typed', path: 'text' } },
      output_kind: 'note',
      wrap_instruction_ref: 'instr:vision-board',
    });
  });

  it('every shipped record carries a pollable status block (no eternal Working…)', () => {
    for (const row of rows) {
      expect(producerDescriptorOf(row, 'group.add-shelf')).not.toBeNull();
      expect(row.dispatch.status?.address_mode).toBe('label-hash');
      expect(row.dispatch.status?.result_partition_label).toBe('runtime-partition');
    }
  });
});
