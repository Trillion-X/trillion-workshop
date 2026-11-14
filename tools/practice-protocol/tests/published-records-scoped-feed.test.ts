// packages/practice-protocol/tests/published-records-scoped-feed.test.ts
// L126 scoped-feed guard: PracticeProtocolSurface reads ONLY the 3 practice-protocol
// kinds (read-practice-protocol filters practice-protocol/-step/-state). This locks
// the `published-records` input to a kind-scoped json_array feed
// (`package::practice-protocol::protocol-feed`, in:[3]) instead of the raw 34.7MB
// aggregate. Consumer payloadFromRow reads `row.payload ?? row.value ?? row` → no change.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FEED = 'package::practice-protocol::protocol-feed';
const KINDS = ['practice-protocol', 'practice-protocol-step', 'practice-protocol-state'];

interface Thing {
  type?: string;
  address?: string;
  payload?: Record<string, unknown>;
  payload_bytes?: Record<string, unknown>;
}

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'things-to-store-and-run.json'), 'utf8'),
) as { things: Thing[] };

describe('practice-protocol published-records scoped feed (L126)', () => {
  it('declares a json_array multi-kind (in:[...]) scoped sink', () => {
    const sink = manifest.things.find(
      (t) => t.type === 'record_from_matching_records' && t.address === FEED,
    );
    expect(sink).toBeTruthy();
    const b = sink!.payload_bytes as {
      value_to_bytes?: string;
      rows?: { match?: Array<{ path?: string[]; in?: string[] }> };
    };
    expect(b.value_to_bytes).toBe('json_array');
    const m = b.rows?.match ?? [];
    expect(m.find((x) => x.path?.[0] === 'payload' && x.path?.[1] === 'kind')?.in).toEqual(KINDS);
    expect(m.some((x) => x.path?.length === 1 && x.path?.[0] === 'payload')).toBe(true);
  });

  it('the published-records input reads the scoped feed, not the raw aggregate', () => {
    const desc = manifest.things.find(
      (t) => t.payload?.input_name === 'published-records' && t.payload?.kind === 'bitfield-input-descriptor',
    );
    expect(desc).toBeTruthy();
    const p = desc!.payload as any;
    const loc = p.selected_payload ?? p;
    expect(loc.value_address_label).toBe(FEED);
    expect(loc.value?.source_bytes?.bytes_to_value).toBe('json');
  });

  it('NO descriptor points at the raw published-records aggregate', () => {
    const raw = manifest.things.filter((t) => {
      const p = t.payload as any;
      if (p?.kind !== 'bitfield-input-descriptor') return false;
      return (
        p.value_address_label === 'published-records' ||
        p.selected_payload?.value_address_label === 'published-records'
      );
    });
    expect(raw).toEqual([]);
  });
});
