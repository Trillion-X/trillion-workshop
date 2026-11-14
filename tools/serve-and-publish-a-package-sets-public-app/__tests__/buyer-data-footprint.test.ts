import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
const artifactRoot = path.join(packageRoot, 'read-data', 'artifacts');
const source = readdirSync(artifactRoot).filter((name) => name.endsWith('.txt'))
  .map((name) => readFileSync(path.join(artifactRoot, name), 'utf8')).join('\n');

describe('buyer data footprint', () => {
  it('creates no durable browser identity, grant, seller-record, or protected-byte store', () => {
    for (const forbidden of [
      'localStorage', 'sessionStorage', 'indexedDB', 'caches.open(', 'CacheStorage',
      'navigator.serviceWorker', 'serviceWorker.register', 'sourceMappingURL',
    ]) expect(source).not.toContain(forbidden);
  });

  it('marks every buyer network response private and non-persistent', () => {
    for (const route of [
      'app-api-experience-manifest-route.ts.txt', 'app-api-experience-bytes-route.ts.txt',
      'app-api-experience-data-route.ts.txt', 'app-api-experience-subscriptions-route.ts.txt',
      'hosted-target-route.ts.txt',
    ]) expect(readFileSync(path.join(artifactRoot, route), 'utf8')).toContain('no-store');
  });

  it('retains canonical records with their owners rather than duplicating access state in Hosted Public App', () => {
    const authority = readFileSync(path.join(artifactRoot, 'hosted-experience-authority.ts.txt'), 'utf8');
    expect(authority).toContain('slot::find-current-items');
    expect(authority).toContain('product-access.authorize-addressed-expiring-value-scope');
    expect(authority).not.toContain('createGrant');
    expect(authority).not.toContain('saveProfile');
  });
});
