import { readFileSync } from 'node:fs';
import { dataRows } from '../src/data-rows.mjs';

/** Build namespace-related Worker variables from the configured origin bindings. */
export function namespaceWorkerVars(namespaceOrigins) {
  const publishedOrigin = namespaceOrigins.find(({ row }) => row.interface === 'object-bucket' && typeof row.binding === 'string' && row.binding);
  if (!publishedOrigin) throw new Error('No usable object-bucket namespace origin can store published files.');

  return {
    NAMESPACE_ORIGINS: JSON.stringify(namespaceOrigins.map(({ row }) => row)),
    PUBLISHED_FILE_BINDING: publishedOrigin.row.binding,
  };
}

/** The binding a Worker reaches an object-bucket namespace origin's bucket by. */
export const namespaceBucketBinding = id => `NAMESPACE_BYTES_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/** The cloud-files.origin rows this app chose (records/cloud-files-origins.json), each joined by id to this app's own
 *  choices for it (records/cloud-files-origin-settings.json: rank, label, settings, byte ceiling), in rank order. Every
 *  runtime that keeps namespace files (a deploy, a local run) places them from this one list. */
export function chosenCloudFileOrigins(root = new URL('..', import.meta.url)) {
  const records = name => JSON.parse(readFileSync(new URL(`records/${name}.json`, root), 'utf8'));
  const origins = dataRows('storage-origin', records('cloud-files-origins'));
  const settings = dataRows('storage-origin-settings', records('cloud-files-origin-settings'));
  return origins
    .map(origin => { const own = settings.find(row => row.origin_id === origin.id); return own ? { ...origin, rank: own.rank, label: own.label ?? null, settings: own.settings ?? {}, max_bytes: own.max_bytes ?? null } : null; })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank);
}
