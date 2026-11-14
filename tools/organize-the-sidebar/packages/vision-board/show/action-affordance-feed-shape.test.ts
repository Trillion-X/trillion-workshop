// packages/vision-board/show/action-affordance-feed-shape.test.ts
//
// L126 read-path regression guard: `mount-vision-board.tsx` reads the
// `published-records` input AFTER it was repointed (in things-to-store-and-run.json)
// to the scoped `record_from_matching_records` json_array sink
// `package::vision-board::action-affordance-feed`. That sink delivers rows shaped
// `{record: {address, source_package?}, payload}` — NOT the aggregate's flat
// `{address, payload}` shape, and NOT `{records: [...]}`. The mount does
// `readActionAffordances(readPublishedRecords(publishedRecordsRaw))` directly, with
// NO `normalizeFeedRows` step (unlike GroupBoardPanel, which normalizes its OWN
// separate `group-owned-feed`).
//
// This test proves that omission is safe: it feeds the EXACT scoped-feed row shape
// (bare array of `{record:{address},payload}`) through the mount's own decode
// chain and asserts the two shelf tools still resolve. If `readPublishedRecords`
// ever regresses to only accepting `{records:[...]}` or the flat `{address,payload}`
// shape, this test goes red BEFORE the shelf silently loses its tools in the browser
// (the #47-class failure: a read-path decode gap makes real records disappear with
// no error, because an empty list is a legal — if wrong — decode result).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readActionAffordances } from '@/packages/ui/show/action-affordance';
import { readPublishedRecords } from '@/packages/ui/show/placeable-surface-intent';
import { affordanceShelfTools } from '@/packages/group/show/board-action-affordances';

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'things-to-store-and-run.json'), 'utf8'),
) as { things: Array<{ type: string; address: string; payload: unknown }> };

// Reconstruct exactly what the live `action-affordance-feed` sink would deliver at
// runtime: a bare JSON array of `{record: {address, source_package}, payload}` rows
// — the record_from_matching_records json_array shape (rows.match on payload.kind),
// scoped to this package's own action-affordance records only.
const scopedFeedRows = manifest.things
  .filter((t) => t.type === 'record' && isActionAffordancePayload(t.payload))
  .map((t) => ({
    record: { address: t.address, source_package: 'vision-board' },
    payload: t.payload,
  }));

function isActionAffordancePayload(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    && (payload as Record<string, unknown>).kind === 'action-affordance';
}

describe('vision-board scoped action-affordance feed decodes through the mount path', () => {
  it('the manifest actually has 2 action-affordance records to scope (sanity)', () => {
    expect(scopedFeedRows).toHaveLength(2);
  });

  it('readPublishedRecords decodes the bare {record:{address},payload} array (no {records:[...]} wrapper needed)', () => {
    const decoded = readPublishedRecords(scopedFeedRows);
    expect(decoded).toHaveLength(2);
    expect(decoded.map((r) => r.recordId).sort()).toEqual([
      'package::vision-board::action-affordance::breakdown',
      'package::vision-board::action-affordance::vision',
    ]);
    // sourcePackage recovered from record.source_package (not just address-parsing).
    expect(decoded.every((r) => r.sourcePackage === 'vision-board')).toBe(true);
  });

  it('the mount\'s exact chain (readActionAffordances(readPublishedRecords(raw))) yields both rows', () => {
    const rows = readActionAffordances(readPublishedRecords(scopedFeedRows));
    expect(rows.map((r) => r.label).sort()).toEqual(['Break down', 'Vision']);
  });

  it('affordanceShelfTools resolves 2 shelf tools from the scoped-feed shape — the board never goes empty', () => {
    const rows = readActionAffordances(readPublishedRecords(scopedFeedRows));
    const tools = affordanceShelfTools(rows, { surface: { board_id: 'vision-board' } });
    expect(tools.map((t) => t.label).sort()).toEqual(['Break down', 'Vision']);
    // Every tool must carry a resolvable producer (pollable) — an unresolved
    // scoped row would silently drop out of affordanceShelfTools (producerDescriptorOf
    // returns null without a status block), which is the exact silent-empty failure
    // mode this test exists to catch.
    for (const tool of tools) expect(tool.producer).not.toBeNull();
  });

  it('an EMPTY scoped feed (no records match the sink filter) yields an empty, not crashed, tool list', () => {
    const rows = readActionAffordances(readPublishedRecords([]));
    expect(affordanceShelfTools(rows, { surface: { board_id: 'vision-board' } })).toEqual([]);
  });
});
