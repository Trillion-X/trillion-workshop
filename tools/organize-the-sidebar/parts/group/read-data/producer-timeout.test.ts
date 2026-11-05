import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  PRODUCER_TIMEOUT_MS_DEFAULT,
  producerStartMs,
  producerLimitMs,
  producerTimedOut,
} from '../../../read-data/producer-timeout.ts';

describe('producerStartMs — the fail-closed clock starts at the honest dispatch stamp', () => {
  it('uses the submit stamp when it is a positive number (the SSOT `started_at`)', () => {
    expect(producerStartMs(1_000, 9_999)).toBe(1_000);
  });

  it('ignores the stamp and falls back for every non-positive / non-number value', () => {
    // These are exactly the shapes the phantom `submittedAtMs` read produced —
    // each must route to the first-seen fallback, never silently become 0/NaN.
    for (const bad of [undefined, null, 0, -5, NaN, '1000', {}, [], true]) {
      expect(producerStartMs(bad as unknown, 4_242)).toBe(4_242);
    }
  });

  it('is pure: same inputs → same output, no clock, no mutation', () => {
    const stamp = 123;
    expect(producerStartMs(stamp, 500)).toBe(producerStartMs(stamp, 500));
  });
});

describe('producerLimitMs — owner DATA overrides the default, else the default', () => {
  it('uses a positive owner-supplied limit', () => {
    expect(producerLimitMs(5_000)).toBe(5_000);
  });

  it('falls back to the default for missing / non-positive / non-number limits', () => {
    for (const bad of [undefined, null, 0, -1, NaN, '5000', {}]) {
      expect(producerLimitMs(bad as unknown)).toBe(PRODUCER_TIMEOUT_MS_DEFAULT);
    }
  });

  it('default is 180s', () => {
    expect(PRODUCER_TIMEOUT_MS_DEFAULT).toBe(180_000);
  });
});

describe('producerTimedOut — strict: exactly-at-limit is not yet out', () => {
  const start = 1_000_000;
  const limit = 180_000;

  it('false before the limit', () => {
    expect(producerTimedOut(start, start + limit - 1, limit)).toBe(false);
  });

  it('false exactly at the limit (boundary is inclusive of "still working")', () => {
    expect(producerTimedOut(start, start + limit, limit)).toBe(false);
  });

  it('true one ms past the limit', () => {
    expect(producerTimedOut(start, start + limit + 1, limit)).toBe(true);
  });
});

describe('composition — a reopened stamped orphan resolves from its TRUE dispatch time', () => {
  it('a card dispatched long ago is already timed out even though this session just saw it', () => {
    const dispatchedAt = 0; // owner stamped `started_at` an hour ago
    const firstSeenThisSession = 3_600_000; // board reopened now
    const now = 3_600_000;
    // The bug (reading the phantom key) measured from firstSeen → NOT timed out,
    // so the orphan restarted its clock every reopen. With the SSOT stamp it is
    // correctly declared failed.
    const startMs = producerStartMs(dispatchedAt || firstSeenThisSession, firstSeenThisSession);
    // `dispatchedAt` is 0 here (falsy) so this proves the >0 guard: 0 is treated
    // as "no stamp". A genuine epoch-ms stamp is always > 0, so use a real one:
    const realStart = producerStartMs(1, firstSeenThisSession);
    expect(realStart).toBe(1);
    expect(producerTimedOut(realStart, now, producerLimitMs(undefined))).toBe(true);
    // and the fallback path (stamp-less legacy orphan) measures from first-seen:
    expect(producerTimedOut(startMs, now, producerLimitMs(undefined))).toBe(false);
  });
});

describe('fail-closed against non-finite (Infinity) DATA (cont.98 batch-8)', () => {
  it('producerLimitMs(Infinity/NaN) falls back to the default — not an unbounded limit', () => {
    expect(producerLimitMs(Infinity)).toBe(PRODUCER_TIMEOUT_MS_DEFAULT);
    expect(producerLimitMs(NaN)).toBe(PRODUCER_TIMEOUT_MS_DEFAULT);
    expect(producerLimitMs(60_000)).toBe(60_000); // a finite positive limit is still honoured
  });

  it('producerStartMs(Infinity, fallback) uses the finite fallback — an Infinity stamp would never time out', () => {
    expect(producerStartMs(Infinity, 100)).toBe(100);
    // with the finite fallback clock the card DOES eventually time out (fail-closed restored)
    expect(producerTimedOut(producerStartMs(Infinity, 0), 200_000, producerLimitMs(undefined))).toBe(true);
  });
});
