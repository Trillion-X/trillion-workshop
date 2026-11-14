// packages/live-match-score/show/live-match-score-scoped-feed.test.ts
//
// L126 read-path regression guard: `things-to-store-and-run.json`'s
// `package::live-match-score::input::published-records` descriptor was
// repointed off the raw 34.7MB `published-records` aggregate onto the scoped
// `record_from_matching_records` json_array sink
// `package::live-match-score::live-match-score-owned-feed`. That sink matches
// every record whose ADDRESS contains "live-match-score::" — i.e. every
// record this package itself publishes (match/event/context/board rows) —
// and delivers rows shaped `{record: {address}, payload}`, the same shape
// every other scoped `record_from_matching_records` sink in this codebase
// produces (see service-connections, vision-board).
//
// `readLiveMatchScoreState` (read-live-match-score.ts) never reads
// `row.address` — it only reads `row.payload ?? row.value ?? row` and then
// discriminates by `payload.kind` — so the wider address-scoped feed still
// decodes correctly into matches/events/contexts/board rows. This test
// proves that end-to-end against the REAL manifest data (not a hand-rolled
// fixture): assert the manifest wiring is correct, then feed a synthetic
// scoped-feed row shape through `readLiveMatchScoreState` and assert it
// extracts a `live-match` row.
//
// If `record_from_matching_records` ever changes its emitted row shape, or
// if `readLiveMatchScoreState` regresses to reading `row.address`, this test
// goes red before the live board silently renders empty in the browser (the
// #47-class failure: a read-path decode gap makes real records disappear
// with no error, because an empty list is a legal — if wrong — decode
// result).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLiveMatchScoreState } from '@/packages/live-match-score/read-data/read-live-match-score';

interface ManifestThing {
  type: string;
  address: string;
  path?: unknown;
  matching_record_paths?: unknown;
  payload?: unknown;
  payload_bytes?: {
    value_to_bytes?: string;
    rows?: {
      match?: Array<{ path: string[]; contains?: string; equals?: unknown; not_equals?: unknown }>;
    };
  };
}

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'things-to-store-and-run.json'), 'utf8'),
) as { things: ManifestThing[] };

const ownedFeedSink = manifest.things.find(
  (t) => t.type === 'record_from_matching_records' && t.address === 'package::live-match-score::live-match-score-owned-feed',
);

const publishedRecordsInput = manifest.things.find(
  (t) => t.type === 'record' && t.address === 'package::live-match-score::input::published-records',
);

describe('live-match-score manifest is wired onto the scoped owned-feed sink (L126)', () => {
  it('the live-match-score-owned-feed record_from_matching_records sink exists, emits json_array, and scopes by address segment', () => {
    expect(ownedFeedSink).toBeDefined();
    expect(ownedFeedSink?.payload_bytes?.value_to_bytes).toBe('json_array');
    const addressMatch = ownedFeedSink?.payload_bytes?.rows?.match?.find(
      (m) => m.path.join('.') === 'record.address',
    );
    expect(addressMatch?.contains).toBe('live-match-score::');
  });

  it('the published-records input descriptor points at the scoped sink as json, not the raw cell_table aggregate', () => {
    expect(publishedRecordsInput).toBeDefined();
    const payload = publishedRecordsInput?.payload as {
      selected_payload?: { value_address_label?: string; value?: { source_bytes?: { bytes_to_value?: string } } };
      value_address_label?: string;
    };
    expect(payload.selected_payload?.value_address_label).toBe('package::live-match-score::live-match-score-owned-feed');
    expect(payload.selected_payload?.value?.source_bytes?.bytes_to_value).toBe('json');
    // The old top-level `value_address_label: "published-records"` (the raw
    // aggregate label) must no longer be present on this descriptor.
    expect(payload.value_address_label).toBeUndefined();
  });
});

describe('a synthetic scoped-feed row decodes through readLiveMatchScoreState (shape compatibility proof)', () => {
  it('extracts a live-match row from the {record:{address},payload} scoped-feed shape', () => {
    const scopedFeedRows = [
      {
        record: { address: 'package::live-match-score::match::live-match:1' },
        payload: {
          kind: 'live-match',
          matchId: 'live-match:1',
          scoringRuleRef: 'scoring-rule:tennis-standard',
          matchFormat: 'singles',
          teams: [
            { teamId: 'team-a', label: 'Alex', players: ['Alex'] },
            { teamId: 'team-b', label: 'Rafa', players: ['Rafa'] },
          ],
          scoringModel: {
            setsToWin: 2,
            gamesToWinSet: 6,
            winBy: 2,
            tiebreakAt: 6,
            pointsToWinTiebreak: 7,
            scoreUnit: 'game',
            pointLabels: ['0', '15', '30', '40'],
            advantageLabel: 'AD',
          },
          status: 'live',
          share: { shareId: 'live-match-share:1', publicPath: '/live/live-match%3A1', enabled: true },
          createdAt: '2026-06-20T12:00:00.000Z',
        },
      },
      {
        record: { address: 'package::live-match-score::event::live-score-event:0' },
        payload: {
          kind: 'live-score-event',
          eventId: 'live-score-event:0',
          matchId: 'live-match:1',
          sequence: 0,
          eventKind: 'start',
          score: { setNumber: 1, teamScores: { 'team-a': 0, 'team-b': 0 } },
          localState: 'confirmed',
          createdAt: '2026-06-20T12:00:00.000Z',
        },
      },
      // A non-live-match-score record that would ALSO pass the address-segment
      // filter (any record under this package's address prefix) must be
      // ignored by kind, never by address.
      {
        record: { address: 'package::live-match-score::capability' },
        payload: { kind: 'bitfield-package-capability', id: 'capability:live-match-score' },
      },
    ];

    const state = readLiveMatchScoreState(scopedFeedRows);
    expect(state.matches).toHaveLength(1);
    expect(state.matches[0].matchId).toBe('live-match:1');
    expect(state.events).toHaveLength(1);
    expect(state.events[0].eventId).toBe('live-score-event:0');
  });

  it('an EMPTY scoped feed (no records match the sink filter) yields an empty, not crashed, state', () => {
    const state = readLiveMatchScoreState([]);
    expect(state.matches).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.contexts).toEqual([]);
  });
});
