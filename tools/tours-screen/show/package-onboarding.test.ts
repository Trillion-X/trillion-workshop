import { describe, expect, it, vi } from '../../../test-helpers/vitest-shim.mjs';
import { emitPackageSurfaceEntered, PACKAGE_ONBOARDING_EVENT } from './package-onboarding.ts';

describe('generic package onboarding seam', () => {
  it('emits semantic package and surface DATA without owning product copy', () => {
    const dispatchEvent = vi.fn(() => true);
    const detail = emitPackageSurfaceEntered('chat', 'chat', { dispatchEvent });

    expect(detail).toEqual({
      event_kind: 'package-surface-entered',
      package_ref: 'chat',
      surface_ref: 'chat',
    });
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({ type: PACKAGE_ONBOARDING_EVENT, detail });
  });

  it('fails closed when either semantic identity is absent', () => {
    expect(() => emitPackageSurfaceEntered('', 'chat', null)).toThrow(/package_ref/);
    expect(() => emitPackageSurfaceEntered('chat', ' ', null)).toThrow(/surface_ref/);
  });
});
