// src/tool-releases.mjs
//
// Purpose
//   Which release of a Marketplace tool this Trillion runs. A published tool row may say the oldest Trillion it runs on
//   (`minimum_host_version`); a newer release that needs a newer Trillion keeps the maker's earlier releases with it
//   (`earlier_releases`), so a Trillion that is not yet updated (a person's Mac app a version behind the web) runs the
//   newest release it can, and says which version it needs when it can run none.
//
// Non-negotiable invariants
//   1. The host version is one value: server.json `version`, the version every directory lists for this Trillion.
//   2. The newest compatible release wins: the published row itself, else the first earlier release whose minimum is met.
//      A release with no minimum runs everywhere.
//   3. Earlier releases are kept only when they can still be chosen: each minimum strictly lower than the new row's,
//      one per minimum (the newest), at most `keep_earlier` (src/tool-releases.json). A row with no minimum keeps none.
//   4. Only the same maker's earlier rows are kept: another account's row of the same id is never folded in.
//   5. Nothing here reads or writes the Marketplace; the Workshop (src/workshop.mjs) calls it on what it read. A malformed
//      minimum is refused by the one catalog decoder (parts/ai-tool-catalog/read-data, MINIMUM_HOST_VERSION) when saved.
import listing from '../server.json' with { type: 'json' };
import settings from './tool-releases.json' with { type: 'json' };

export const HOST_VERSION = listing.version;

/** Negative, zero or positive as version `a` is older than, the same as, or newer than `b` (missing parts are 0). */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number), right = String(b).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

const runsOn = (release, hostVersion) => !release.minimum_host_version || compareVersions(hostVersion, release.minimum_host_version) >= 0;
const releaseOnly = ({ earlier_releases: _earlier, ...release }) => release;

/** The release of a published row this host runs (invariant 2), without its earlier releases; null when none runs here. */
export function compatibleRelease(row, hostVersion = HOST_VERSION) {
  if (!row || typeof row !== 'object') return null;
  const found = [row, ...(Array.isArray(row.earlier_releases) ? row.earlier_releases : [])].find(release => release && runsOn(release, hostVersion));
  return found ? releaseOnly(found) : null;
}

/** The oldest Trillion any release of a row runs on (the version to name when this host runs none of them). */
export const oldestNeeded = row => [row, ...(Array.isArray(row?.earlier_releases) ? row.earlier_releases : [])]
  .map(release => release?.minimum_host_version).filter(Boolean).sort(compareVersions)[0] ?? null;

/** The row to publish: `row` with the earlier releases of the same maker's `previous` row it should keep (invariant 3). */
export function withEarlierReleases(row, previous) {
  const { earlier_releases: _given, ...published } = row;
  if (!published.minimum_host_version || !previous) return published;
  const kept = [];
  const minimums = new Set();
  for (const release of [releaseOnly(previous), ...(Array.isArray(previous.earlier_releases) ? previous.earlier_releases : [])]) {
    const minimum = release.minimum_host_version ?? '0';
    if (compareVersions(minimum, published.minimum_host_version) >= 0 || minimums.has(minimum)) continue;
    minimums.add(minimum);
    kept.push(releaseOnly(release));
    if (kept.length === settings.keep_earlier) break;
  }
  return kept.length ? { ...published, earlier_releases: kept } : published;
}
