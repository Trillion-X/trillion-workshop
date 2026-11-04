// packages/group/read-data/board-forecast.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { forecast, compareForecasts, type Forecast } from '../../../read-data/board-forecast.ts';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('board-forecast leaf', () => {
  it('complete when nothing remains — projected = now, no required pace', () => {
    const f = forecast({ remainingUnits: 0, velocityPerHour: 5, now: NOW, due: NOW + DAY });
    expect(f.verdict).toBe('complete');
    expect(f.projectedMs).toBe(NOW);
    expect(f.hoursRemaining).toBe(0);
    expect(f.requiredVelocityPerHour).toBeNull();
    expect(f.slackMs).toBe(DAY); // a whole day of spare, already done
  });

  it('non-finite remaining fails CLOSED to stalled — NOT a false "complete" (cont.98 batch-19)', () => {
    // A non-finite remaining (NaN, or an Infinity from a crafted metric whose span overflows) is
    // UNQUANTIFIABLE, not done. Reporting "complete" was fail-OPEN (a false finish); the leaf now fails
    // closed to stalled with no projected date. Codex-confirmed reachable via `remaining(metric)` overflow.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = forecast({ remainingUnits: bad, velocityPerHour: 5, now: NOW });
      expect(f.verdict).toBe('stalled');
      expect(f.projectedMs).toBeNull();
      expect(f.hoursRemaining).toBeNull();
    }
  });

  it('stalled when work remains but velocity is zero/null — NO projected date, but required pace shown', () => {
    const zero = forecast({ remainingUnits: 10, velocityPerHour: 0, now: NOW, due: NOW + 5 * HOUR });
    expect(zero.verdict).toBe('stalled');
    expect(zero.projectedMs).toBeNull();
    expect(zero.hoursRemaining).toBeNull();
    expect(zero.requiredVelocityPerHour).toBe(2); // 10 units / 5h
    const nul = forecast({ remainingUnits: 10, velocityPerHour: null, now: NOW });
    expect(nul.verdict).toBe('stalled');
    expect(nul.requiredVelocityPerHour).toBeNull(); // no deadline → no required pace
  });

  it('moving (no deadline) — projects a finish, no ahead/behind', () => {
    const f = forecast({ remainingUnits: 10, velocityPerHour: 2, now: NOW });
    expect(f.verdict).toBe('moving');
    expect(f.hoursRemaining).toBe(5);
    expect(f.projectedMs).toBe(NOW + 5 * HOUR);
    expect(f.slackMs).toBeNull();
    expect(f.requiredVelocityPerHour).toBeNull();
  });

  it('ahead when the projected finish lands on/before the deadline', () => {
    const f = forecast({ remainingUnits: 10, velocityPerHour: 5, now: NOW, due: NOW + 5 * HOUR });
    expect(f.verdict).toBe('ahead'); // 2h to finish, 5h deadline
    expect(f.hoursRemaining).toBe(2);
    expect(f.slackMs).toBe(3 * HOUR);
    expect(f.requiredVelocityPerHour).toBe(2); // pace that would exactly hit the deadline
  });

  it('behind when the projected finish lands after the deadline', () => {
    const f = forecast({ remainingUnits: 10, velocityPerHour: 1, now: NOW, due: NOW + 5 * HOUR });
    expect(f.verdict).toBe('behind'); // 10h to finish, 5h deadline
    expect(f.slackMs).toBe(-5 * HOUR);
    expect(f.requiredVelocityPerHour).toBe(2);
  });

  it('a past deadline yields no required pace (cannot make a deadline already gone)', () => {
    const f = forecast({ remainingUnits: 10, velocityPerHour: 1, now: NOW, due: NOW - HOUR });
    expect(f.verdict).toBe('behind'); // projected in the future, due in the past
    expect(f.requiredVelocityPerHour).toBeNull();
    expect(f.slackMs).toBeLessThan(0);
  });

  it('a non-positive due is ignored (fail-closed) — treated as no deadline', () => {
    const f = forecast({ remainingUnits: 10, velocityPerHour: 2, now: NOW, due: 0 });
    expect(f.verdict).toBe('moving');
    expect(f.slackMs).toBeNull();
  });

  it('compareForecasts orders risk-first: behind < stalled < moving < ahead < complete', () => {
    const mk = (v: Forecast['verdict'], slack: number | null = null): Forecast => ({
      verdict: v, hoursRemaining: null, projectedMs: null, requiredVelocityPerHour: null, slackMs: slack,
    });
    const order = [mk('complete'), mk('ahead'), mk('moving'), mk('stalled'), mk('behind')]
      .sort(compareForecasts)
      .map((f) => f.verdict);
    expect(order).toEqual(['behind', 'stalled', 'moving', 'ahead', 'complete']);
  });

  it('within the same verdict, the most-behind slack sorts first', () => {
    const mk = (slack: number): Forecast => ({ verdict: 'behind', hoursRemaining: null, projectedMs: null, requiredVelocityPerHour: null, slackMs: slack });
    const order = [mk(-HOUR), mk(-5 * HOUR), mk(-2 * HOUR)].sort(compareForecasts).map((f) => f.slackMs);
    expect(order).toEqual([-5 * HOUR, -2 * HOUR, -HOUR]);
  });
});

describe('board-forecast — subnormal velocity fails CLOSED, never emits an Infinity "date" (cont.98 batch-19)', () => {
  const NOW2 = 1_000_000_000_000;
  it('a subnormal positive velocity → stalled, no non-finite projectedMs', () => {
    // A crafted metric+time-log can yield velocity = 5e-324 (Number.MIN_VALUE). remainingUnits / velocity
    // then overflows to Infinity → the old code emitted projectedMs = Infinity, a bogus date a renderer
    // would format as garbage. The leaf now fails closed to stalled.
    const f = forecast({ remainingUnits: 1, velocityPerHour: Number.MIN_VALUE, now: NOW2 });
    expect(f.verdict).toBe('stalled');
    expect(f.projectedMs).toBeNull();
    expect(f.hoursRemaining).toBeNull();
  });
  it('a normal velocity still projects a finite date (zero regression)', () => {
    const f = forecast({ remainingUnits: 10, velocityPerHour: 2, now: NOW2 });
    expect(f.verdict).toBe('moving');
    expect(Number.isFinite(f.projectedMs!)).toBe(true);
    expect(f.hoursRemaining).toBe(5);
  });
});
