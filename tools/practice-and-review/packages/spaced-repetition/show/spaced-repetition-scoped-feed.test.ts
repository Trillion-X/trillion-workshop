// packages/spaced-repetition/show/spaced-repetition-scoped-feed.test.ts
//
// L126 read-path regression guard: `things-to-store-and-run.json`'s
// `package::spaced-repetition::input::published-records` descriptor was repointed
// off the raw 34.7MB `published-records` aggregate onto the scoped
// `record_from_matching_records` json_array sink
// `package::spaced-repetition::spaced-repetition-owned-feed`. That sink matches
// every record whose `payload.kind` is one of this package's four owned kinds
// (review-prompt / review-schedule / review-response-request /
// review-schedule-policy) — kind-scoping is guaranteed-correct here because
// `readSpacedRepetitionState` discriminates by exactly those kinds, so the feed
// captures precisely what the surface reads, regardless of write address.
//
// The sink emits rows shaped `{record:{address}, payload}` (the shape every
// scoped sink emits — see live-match-score, match-picks). `readSpacedRepetitionState`
// never reads `row.address`; `payloadFromRow` reads `row.payload ?? row.value ?? row`
// and discriminates by `payload.kind`, so the wider-shaped feed decodes correctly.
// If the sink shape changes or the reader regresses to reading `row.address`, this
// test goes red before the live surface silently renders empty (the #47-class
// read-path decode gap where real records disappear with no error).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSpacedRepetitionState } from '@/packages/spaced-repetition/read-data/read-spaced-repetition';

interface ManifestThing {
  type: string;
  address: string;
  payload?: unknown;
  payload_bytes?: {
    value_to_bytes?: string;
    rows?: { match?: Array<{ path: string[]; in?: unknown[]; contains?: string; not_equals?: unknown }> };
  };
}

const manifest = JSON.parse(
  readFileSync(join(__dirname, '..', 'things-to-store-and-run.json'), 'utf8'),
) as { things: ManifestThing[] };

const ownedFeedSink = manifest.things.find(
  (t) =>
    t.type === 'record_from_matching_records' &&
    t.address === 'package::spaced-repetition::spaced-repetition-owned-feed',
);
const publishedRecordsInput = manifest.things.find(
  (t) => t.type === 'record' && t.address === 'package::spaced-repetition::input::published-records',
);

describe('spaced-repetition manifest is wired onto the scoped owned-feed sink (L126)', () => {
  it('the owned-feed record_from_matching_records sink exists, emits json_array, scopes by owned kinds', () => {
    expect(ownedFeedSink).toBeDefined();
    expect(ownedFeedSink?.payload_bytes?.value_to_bytes).toBe('json_array');
    const kindMatch = ownedFeedSink?.payload_bytes?.rows?.match?.find((m) => m.path.join('.') === 'payload.kind');
    expect(kindMatch?.in).toEqual([
      'review-prompt',
      'review-schedule',
      'review-response-request',
      'review-schedule-policy',
    ]);
  });

  it('the published-records input points at the scoped sink as json, not the raw cell_table aggregate', () => {
    expect(publishedRecordsInput).toBeDefined();
    const payload = publishedRecordsInput?.payload as {
      selected_payload?: { value_address_label?: string; value?: { source_bytes?: { bytes_to_value?: string } } };
      value_address_label?: string;
    };
    expect(payload.selected_payload?.value_address_label).toBe('package::spaced-repetition::spaced-repetition-owned-feed');
    expect(payload.selected_payload?.value?.source_bytes?.bytes_to_value).toBe('json');
    // The old top-level raw aggregate label must be gone from this descriptor.
    expect(payload.value_address_label).toBeUndefined();
  });
});

describe('a scoped-feed row decodes through readSpacedRepetitionState (shape compatibility proof)', () => {
  it('extracts prompts / schedules / responses from the {record:{address},payload} scoped-feed shape', () => {
    const scopedFeedRows = [
      { record: { address: 'package::spaced-repetition::prompt::p1' }, payload: { kind: 'review-prompt', promptId: 'p1', prompt: 'Split step timing' } },
      { record: { address: 'package::spaced-repetition::schedule::s1' }, payload: { kind: 'review-schedule', promptId: 'p1', dueAt: '2026-07-21T00:00:00Z', state: 'pending' } },
      { record: { address: 'package::spaced-repetition::request::r1' }, payload: { kind: 'review-response-request', requestId: 'r1', promptId: 'p1' } },
      // A non-content record under the same address prefix must be ignored by kind, never by address.
      { record: { address: 'package::spaced-repetition::capability' }, payload: { kind: 'bitfield-package-capability', id: 'capability:spaced-repetition' } },
    ];
    const state = readSpacedRepetitionState(scopedFeedRows);
    expect(state.prompts).toHaveLength(1);
    expect(state.schedules).toHaveLength(1);
    expect(state.responses).toHaveLength(1);
  });

  it('an EMPTY scoped feed yields an empty, not crashed, state', () => {
    const state = readSpacedRepetitionState([]);
    expect(state.prompts).toEqual([]);
    expect(state.schedules).toEqual([]);
    expect(state.responses).toEqual([]);
  });
});
