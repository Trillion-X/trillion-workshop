import { describe, expect, it } from 'vitest';
import {
  decodeMeetingCaptureStartPolicy,
  decodeRecordAudioCapturePolicy,
  decideMeetingCaptureStart,
  type MeetingCaptureStartEvent,
} from './capture-policy';

describe('record-audio capture policy', () => {
  it('decodes DATA-selected recovery timing', () => {
    expect(decodeRecordAudioCapturePolicy({ journal_lease_ms: 9_000, journal_heartbeat_ms: 2_000 }))
      .toEqual({ journalLeaseMs: 9_000, journalHeartbeatMs: 2_000 });
  });

  it('fails closed to bounded defaults for absent or invalid values', () => {
    expect(decodeRecordAudioCapturePolicy({ journal_lease_ms: 0, journal_heartbeat_ms: 'bad' }))
      .toEqual({ journalLeaseMs: 5_000, journalHeartbeatMs: 1_000 });
  });

  it('keeps the heartbeat inside the owner lease so a live capture is never recovered early', () => {
    expect(decodeRecordAudioCapturePolicy({ journal_lease_ms: 4_000, journal_heartbeat_ms: 9_000 }))
      .toEqual({ journalLeaseMs: 4_000, journalHeartbeatMs: 2_000 });
  });

  it('decodes legacy scalar preferences and all four canonical modes', () => {
    for (const mode of ['automatic', 'through-app', 'reminder', 'manual'] as const) {
      expect(decodeMeetingCaptureStartPolicy(mode).mode).toBe(mode);
      expect(decodeMeetingCaptureStartPolicy({ meeting_start: { mode } }).mode).toBe(mode);
    }
    expect(decodeMeetingCaptureStartPolicy('unknown').mode).toBe('manual');
  });

  it('maps each mode to its existing capture decision', () => {
    const joined: MeetingCaptureStartEvent = { kind: 'meeting-join-initiated', throughApp: true, appId: 'app.alpha' };
    const nativeInput: MeetingCaptureStartEvent = { kind: 'application-input-started', throughApp: false, appId: 'app.alpha' };
    expect(decideMeetingCaptureStart(decodeMeetingCaptureStartPolicy('automatic'), nativeInput)).toBe('start');
    expect(decideMeetingCaptureStart(decodeMeetingCaptureStartPolicy('through-app'), joined)).toBe('start');
    expect(decideMeetingCaptureStart(decodeMeetingCaptureStartPolicy('through-app'), nativeInput)).toBe('manual');
    expect(decideMeetingCaptureStart(decodeMeetingCaptureStartPolicy('reminder'), nativeInput)).toBe('remind');
    expect(decideMeetingCaptureStart(decodeMeetingCaptureStartPolicy('manual'), joined)).toBe('manual');
  });

  it('applies exact stable app IDs with blocked taking precedence over allowed', () => {
    const policy = decodeMeetingCaptureStartPolicy({ meeting_start: {
      mode: 'automatic', allowed_apps: ['app.alpha', 'app.alpha', 'App.Beta'], blocked_apps: ['app.alpha'],
    } });
    expect(policy.allowedApps).toEqual(['app.alpha', 'App.Beta']);
    expect(decideMeetingCaptureStart(policy, { kind: 'meeting-join-initiated', throughApp: true, appId: 'app.alpha' }))
      .toBe('ignore');
    expect(decideMeetingCaptureStart(policy, { kind: 'application-input-started', throughApp: false, appId: 'App.Beta' }))
      .toBe('start');
    expect(decideMeetingCaptureStart(policy, { kind: 'application-input-started', throughApp: false, appId: 'app.beta' }))
      .toBe('ignore');
  });

  it('ignores an unknown app under an allowlist and fails closed on malformed app policies', () => {
    const allowlisted = decodeMeetingCaptureStartPolicy({ meeting_start: { mode: 'automatic', allowed_apps: ['app.alpha'] } });
    const unknownApp: MeetingCaptureStartEvent = { kind: 'application-input-started', throughApp: false };
    expect(decideMeetingCaptureStart(allowlisted, unknownApp)).toBe('manual');
    expect(decideMeetingCaptureStart(allowlisted, { ...unknownApp, appId: 'app.unknown' })).toBe('ignore');
    expect(decodeMeetingCaptureStartPolicy({ meeting_start: { mode: 'automatic', allowed_apps: ['app.alpha', 7] } }).mode)
      .toBe('manual');
    expect(decodeMeetingCaptureStartPolicy({ meeting_start: { mode: 'automatic', blocked_apps: 'app.alpha' } }).mode)
      .toBe('manual');
  });

  it('does not widen malformed runtime policy into automatic capture', () => {
    expect(decideMeetingCaptureStart({ mode: 'automatic', allowedApps: [' '], blockedApps: [] }, {
      kind: 'meeting-join-initiated', throughApp: true, appId: 'app.alpha',
    })).toBe('manual');
    expect(decideMeetingCaptureStart(decodeMeetingCaptureStartPolicy('automatic'), {
      kind: 'application-input-started', throughApp: false, appId: ' ',
    })).toBe('manual');
    expect(decodeMeetingCaptureStartPolicy({ meeting_start: { mode: 'automatic', allowed_apps: ['app.alpha'.repeat(100)] } }).mode)
      .toBe('manual');
  });
});
