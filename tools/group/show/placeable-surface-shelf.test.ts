// packages/group/show/placeable-surface-shelf.test.ts
//
// #212 — the board's "Live surface" variants are DERIVED from the shared
// placeable-surface catalog, naming no product. These tests use arbitrary package
// names (the deletion test): the mapping works for ANY published surface, so the
// board offers whatever the app has published with zero group edits.

import { describe, expect, it } from 'vitest';
import { placeableSurfaceVariants, LIVE_SURFACE_FOOTPRINT } from 'trillion-workshop/tools/organize-the-sidebar/show/placeable-surface-shelf.ts';
import type { PublishedRecord } from '../../ui/show/placeable-surface-intent/placeable-surface-record';

function surfaceRecord(payload: Record<string, unknown>, recordId = 'r'): PublishedRecord {
  return { recordId, payload: { kind: 'placeable-surface', ...payload } } as PublishedRecord;
}

describe('placeableSurfaceVariants', () => {
  it('maps a published surface with a packageEntry into a seed-carrying shelf variant', () => {
    const variants = placeableSurfaceVariants([
      surfaceRecord({
        material_target: 'target-a',
        label: 'Dashboard',
        icon: 'LayoutDashboard',
        package_entry: { package_name: 'visual-database', entry_name: 'visual-database' },
        order: 1,
      }),
    ]);
    expect(variants).toEqual([
      {
        id: 'live-surface:visual-database:visual-database',
        label: 'Dashboard',
        icon: 'LayoutDashboard',
        defaultW: LIVE_SURFACE_FOOTPRINT.w,
        defaultH: LIVE_SURFACE_FOOTPRINT.h,
        defaultExtra: {
          placeableSurface: { packageName: 'visual-database', entryName: 'visual-database' },
        },
      },
    ]);
  });

  it('#214: seeds a usable footprint so a placed live surface is bigger than a default note', () => {
    const [v] = placeableSurfaceVariants([
      surfaceRecord({ material_target: 'x', label: 'Board', package_entry: { package_name: 'p', entry_name: 'e' } }),
    ]);
    expect(v?.defaultW).toBe(LIVE_SURFACE_FOOTPRINT.w);
    expect(v?.defaultH).toBe(LIVE_SURFACE_FOOTPRINT.h);
    // A live surface must be larger than the board's default note size (220×160).
    expect(LIVE_SURFACE_FOOTPRINT.w).toBeGreaterThan(220);
    expect(LIVE_SURFACE_FOOTPRINT.h).toBeGreaterThan(160);
  });

  it('DELETION TEST: names no product — a totally different published package maps identically', () => {
    const variants = placeableSurfaceVariants([
      surfaceRecord({
        material_target: 'x',
        label: 'Anything',
        package_entry: { package_name: 'some-future-pkg', entry_name: 'whatever' },
      }),
    ]);
    expect(variants[0]?.id).toBe('live-surface:some-future-pkg:whatever');
    expect(variants[0]?.defaultExtra).toEqual({
      placeableSurface: { packageName: 'some-future-pkg', entryName: 'whatever' },
    });
  });

  it('carries surfaceInput through into the seed when present', () => {
    const variants = placeableSurfaceVariants([
      surfaceRecord({
        material_target: 'x',
        label: 'Board of X',
        package_entry: { package_name: 'p', entry_name: 'e' },
        surfaceInput: { subject: 'abc' },
      }),
    ]);
    expect((variants[0]?.defaultExtra as { placeableSurface: { surfaceInput?: unknown } }).placeableSurface.surfaceInput).toEqual({ subject: 'abc' });
  });

  it('drops surfaces with no packageEntry (nothing to mount) and disabled ones', () => {
    const variants = placeableSurfaceVariants([
      surfaceRecord({ material_target: 'no-entry', label: 'Route only' }), // no package_entry
      surfaceRecord({
        material_target: 'disabled',
        label: 'Off',
        package_entry: { package_name: 'p', entry_name: 'e' },
        disabled: true,
      }),
    ]);
    expect(variants).toEqual([]);
  });

  it('empty published-records → no variants (honest empty)', () => {
    expect(placeableSurfaceVariants([])).toEqual([]);
  });
});
