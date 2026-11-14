// @vitest-environment jsdom
// Regression for the #0 launch blocker: the store "Download package file" link built the
// object URL with the hex-encoded COPY-FILE transport scheme
// (objects-named-by-hex-encoded-object-key-text/<hex>), which the live carrier does NOT serve
// (404). The carrier serves objects at their LOGICAL key path. This asserts the builder now
// produces the logical-path URL that returns 200 live.
import { describe, expect, it } from 'vitest';
import type { CatalogInstallActionView, BrowseLocalPackageFileRequestDefaults } from '../read-data/read-catalog-view';
import { packageDownloadUrlFromInstallAction } from './BitfieldPackageStoreBrowseSurface';

const BASE = 'https://packages.bitfield.so/byte-address/package-file-downloads-and-approval-records/filesystem-object-store';
const OBJECT_KEY = 'package-sets/bitfield-package-store/package-files/latest.json';

function actionWithPointer(key: string): CatalogInstallActionView {
  return {
    exchange_refs: { package_file_download_pointer_object_keys: [key] },
  } as unknown as CatalogInstallActionView;
}

function defaultsWithBase(base: string): BrowseLocalPackageFileRequestDefaults {
  return {
    object_store_method: 'http',
    object_store_settings_json: JSON.stringify({ base_url: base }),
  } as unknown as BrowseLocalPackageFileRequestDefaults;
}

describe('packageDownloadUrlFromInstallAction — serves the LOGICAL key path', () => {
  it('builds the logical-path URL the carrier actually serves (not the hex copy-file scheme)', () => {
    const url = packageDownloadUrlFromInstallAction(actionWithPointer(OBJECT_KEY), defaultsWithBase(BASE));
    expect(url).toBe(`${BASE}/${OBJECT_KEY}`);
    // The bug: it must NOT use the hex-encoded copy-file transport name.
    expect(url).not.toContain('objects-named-by-hex-encoded-object-key-text');
  });

  it('preserves "/" separators while encoding each segment', () => {
    const url = packageDownloadUrlFromInstallAction(
      actionWithPointer('package-sets/set with space/package-files/latest.json'),
      defaultsWithBase(BASE),
    );
    expect(url).toBe(`${BASE}/package-sets/set%20with%20space/package-files/latest.json`);
  });

  it('returns null when there is no pointer key', () => {
    expect(packageDownloadUrlFromInstallAction(actionWithPointer('   '), defaultsWithBase(BASE))).toBeNull();
  });

  it('returns null when no base_url is configured', () => {
    expect(packageDownloadUrlFromInstallAction(actionWithPointer(OBJECT_KEY), defaultsWithBase(''))).toBeNull();
  });
});
