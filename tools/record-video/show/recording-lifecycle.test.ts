import { describe, expect, it } from 'vitest';
import { activeDurationMs, beginActiveTime, claimStop, pauseActiveTime, resumeActiveTime } from './recording-lifecycle';

const observation = (reasonRef: string, observedAtMs = 100) => ({
  reasonRef, observedAtMs, sourceRef: `source:${reasonRef}`,
});

describe('recording lifecycle', () => {
  it('excludes every paused interval from active duration', () => {
    let timing = beginActiveTime(1_000);
    timing = pauseActiveTime(timing, 1_400);
    expect(activeDurationMs(timing, 9_000)).toBe(400);
    timing = resumeActiveTime(timing, 10_000);
    timing = pauseActiveTime(timing, 10_300);
    expect(activeDurationMs(timing, 99_000)).toBe(700);
  });

  it('does not cross the active-duration boundary while paused', () => {
    let timing = beginActiveTime(1_000);
    timing = pauseActiveTime(timing, 1_999);
    expect(activeDurationMs(timing, 50_000)).toBe(999);
    timing = resumeActiveTime(timing, 60_000);
    expect(activeDurationMs(timing, 60_001)).toBe(1_000);
  });

  it('keeps active duration non-negative across a backwards wall-clock observation', () => {
    const timing = beginActiveTime(10_000);
    expect(activeDurationMs(timing, 9_000)).toBe(0);
  });

  it('admits exactly one same-tick manual/silence/duration/error stop', () => {
    let state = { phase: 'recording' as const, completion: null, providerStopInvoked: false };
    const fakeProvider = { stopCalls: 0, stop() { this.stopCalls += 1; } };
    const attempts = ['reason:manual', 'reason:silence', 'reason:duration', 'reason:error'].map((reason) => {
      const result = claimStop(state, observation(reason));
      state = result.state;
      if (result.invokeProviderStop) fakeProvider.stop();
      return result;
    });
    expect(attempts.filter((attempt) => attempt.invokeProviderStop)).toHaveLength(1);
    expect(fakeProvider.stopCalls).toBe(1);
    expect(state.completion).toMatchObject({ reasonRef: 'reason:manual', sourceRef: 'source:reason:manual' });
  });

  it('arbitrates every ordered pair of provider-neutral completion observations', () => {
    const reasons = ['manual', 'speech', 'silence', 'duration', 'provider-end', 'provider-error', 'cancel'];
    for (const firstReason of reasons) {
      for (const secondReason of reasons) {
        let state = { phase: 'recording' as const, completion: null, providerStopInvoked: false };
        const first = claimStop(state, observation(`reason:${firstReason}`));
        state = first.state;
        const second = claimStop(state, observation(`reason:${secondReason}`));
        expect(first.invokeProviderStop, `${firstReason} must win its first observation`).toBe(true);
        expect(second.invokeProviderStop, `${secondReason} must lose after ${firstReason}`).toBe(false);
        expect(second.state.completion?.reasonRef).toBe(`reason:${firstReason}`);
      }
    }
  });

  it.each(['stopping', 'flushing', 'saving', 'saved'] as const)('refuses a stop after %s', (phase) => {
    expect(claimStop({ phase, completion: null, providerStopInvoked: phase === 'stopping' }, observation('late')))
      .toMatchObject({ accepted: false, invokeProviderStop: false });
  });

  it('admits browser and non-browser provider observations through the identical contract', () => {
    const browser = observation('reason:provider-ended');
    const nonBrowser = { ...observation('reason:hardware-stop'), sourceRef: 'capture-provider:camera-adapter' };
    for (const providerObservation of [browser, nonBrowser]) {
      expect(Object.keys(providerObservation).sort()).toEqual(['observedAtMs', 'reasonRef', 'sourceRef']);
      expect(claimStop({ phase: 'recording', completion: null, providerStopInvoked: false }, providerObservation))
        .toMatchObject({ accepted: true, state: { completion: providerObservation } });
    }
  });
});
