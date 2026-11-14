import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'read-data', 'artifacts');
const source = (name: string) => readFileSync(path.join(root, name), 'utf8');

describe('buyer authority boundaries', () => {
  it('routes every protected boundary through the shared resolver', () => {
    for (const file of [
      'app-api-experience-manifest-route.ts.txt',
      'app-api-experience-bytes-route.ts.txt',
      'app-api-experience-data-route.ts.txt',
      'app-api-experience-subscriptions-route.ts.txt',
      'hosted-target-route.ts.txt',
    ]) expect(source(file)).toContain('resolveHostedExperienceAuthority');
  });

  it('never exposes a global target or a browser-supplied authority claim', () => {
    const authority = source('hosted-experience-authority.ts.txt');
    expect(authority).toContain('assertNoBrowserClaims');
    expect(authority).toContain('requireManifestRef');
    expect(authority).toContain('const closureRef = exactRef(publication.sealed_closure_ref)');
    expect(authority).toContain('verify-applied-proof');
  });
});
