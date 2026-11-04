// tools/check-a-packages-declared-permissions/do-work/check-a-manifest.mjs
//
// The row's seam over read-data/manifest-permissions.mjs: a package's manifest checked against the permission rows (the
// shipped ones in read-data/manifest-permissions.json, or the caller's own `permissions` rows).
//
//   checkDeclaredPermissions({ manifest, permissions? }) -> { ok, unknown, needs, why? }
import { checkManifest, permissionSettings } from '../read-data/manifest-permissions.mjs';

export function checkDeclaredPermissions({ manifest, permissions } = {}) {
  const shipped = permissionSettings();
  return checkManifest(manifest ?? {}, Array.isArray(permissions) ? { ...shipped, permissions } : shipped);
}
