// PORTED FROM: bitfield-packages/packages/guided-overlay/show/package-onboarding.ts @ e99ac5976
export const PACKAGE_ONBOARDING_EVENT = 'bitfield:walkthrough-event';

export interface PackageSurfaceEnteredDetail {
  readonly event_kind: 'package-surface-entered';
  readonly package_ref: string;
  readonly surface_ref: string;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

/**
 * Generic package-onboarding seam. A product surface reports only its semantic
 * package and surface identities; guided-overlay selects presentation and
 * once/replay policy from walkthrough DATA.
 */
export function emitPackageSurfaceEntered(
  packageRef: string,
  surfaceRef: string,
  target: Pick<Window, 'dispatchEvent'> | null = typeof window === 'undefined' ? null : window,
): PackageSurfaceEnteredDetail {
  const detail: PackageSurfaceEnteredDetail = {
    event_kind: 'package-surface-entered',
    package_ref: requiredText(packageRef, 'package_ref'),
    surface_ref: requiredText(surfaceRef, 'surface_ref'),
  };
  if (target) target.dispatchEvent(new CustomEvent(PACKAGE_ONBOARDING_EVENT, { detail }));
  return detail;
}
