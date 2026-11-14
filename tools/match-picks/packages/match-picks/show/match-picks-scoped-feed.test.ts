// packages/match-picks/show/match-picks-scoped-feed.test.ts
//
// L126 read-path regression guard: `things-to-store-and-run.json`'s
// `package::match-picks::input::published-records` descriptor was repointed off
// the raw 34.7MB `published-records` aggregate onto the scoped
// `record_from_matching_records` json_array sink
// `package::match-picks::match-picks-owned-feed`. That sink matches every record
// whose ADDRESS contains "match-picks::" — every record this package publishes
// (match/pick/result rows) — delivering rows shaped `{record:{address},payload}`,
// the same shape every other scoped sink emits (see live-match-score,
// service-connections, vision-board).
//
// `readMatchPicksState` (read-match-picks.ts) never reads `row.address` — it only
// reads `row.payload ?? row.value ?? row` and discriminates by `payload.kind` —
// so the wider address-scoped feed still decodes correctly into matches/picks/
// results. Proven end-to-end against the REAL manifest data below.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMatchPicksState } from '@/packages/match-picks/read-data/read-match-picks';

interface ManifestThing {
  type: string;
  address: string;
  payload?: unknown;
  payload_bytes?: {
    value_to_bytes?: string;
    rows?: { match?: Array<{ path: string[]; contains?: string; not_equals?: unknown }> };
  };
}

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'things-to-store-and-run.json'), 'utf8'),
) as { things: ManifestThing[] };

const ownedFeedSink = manifest.things.find(
  (t) => t.type === 'record_from_matching_records' && t.address === 'package::match-picks::match-picks-owned-feed',
);
const publishedRecordsInput = manifest.things.find(
  (t) => t.type === 'record' && t.address === 'package::match-picks::input::published-records',
);

describe('match-picks manifest is wired onto the scoped owned-feed sink (L126)', () => {
  it('the match-picks-owned-feed record_from_matching_records sink exists, emits json_array, scopes by address segment', () => {
    expect(ownedFeedSink).toBeDefined();
    expect(ownedFeedSink?.payload_bytes?.value_to_bytes).toBe('json_array');
    const addressMatch = ownedFeedSink?.payload_bytes?.rows?.match?.find((m) => m.path.join('.') === 'record.address');
    expect(addressMatch?.contains).toBe('match-picks::');
  });

  it('the published-records input descriptor points at the scoped sink as json, not the raw cell_table aggregate', () => {
    expect(publishedRecordsInput).toBeDefined();
    const payload = publishedRecordsInput?.payload as {
      selected_payload?: { value_address_label?: string; value?: { source_bytes?: { bytes_to_value?: string } } };
      value_address_label?: string;
    };
    expect(payload.selected_payload?.value_address_label).toBe('package::match-picks::match-picks-owned-feed');
    expect(payload.selected_payload?.value?.source_bytes?.bytes_to_value).toBe('json');
    expect(payload.value_address_label).toBeUndefined();
  });
});

describe('a synthetic scoped-feed row decodes through readMatchPicksState (shape compatibility proof)', () => {
  it('extracts pick-match / match-pick / match-pick-result from the {record:{address},payload} shape', () => {
    const scopedFeedRows = [
      { record: { address: 'package::match-picks::match::m1' }, payload: { kind: 'pick-match', matchId: 'm1' } },
      { record: { address: 'package::match-picks::pick::p1' }, payload: { kind: 'match-pick', pickId: 'p1', matchId: 'm1' } },
      { record: { address: 'package::match-picks::result::r1' }, payload: { kind: 'match-pick-result', resultId: 'r1', pickId: 'p1' } },
      // A non-content record under the same address prefix must be ignored by
      // kind, never by address.
      { record: { address: 'package::match-picks::capability' }, payload: { kind: 'bitfield-package-capability', id: 'capability:match-picks' } },
    ];
    const state = readMatchPicksState(scopedFeedRows);
    expect(state.matches).toHaveLength(1);
    expect(state.picks).toHaveLength(1);
    expect(state.results).toHaveLength(1);
  });

  it('an EMPTY scoped feed yields an empty, not crashed, state', () => {
    const state = readMatchPicksState([]);
    expect(state.matches).toEqual([]);
    expect(state.picks).toEqual([]);
    expect(state.results).toEqual([]);
  });
});
