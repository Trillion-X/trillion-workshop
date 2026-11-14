import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const authority = readFileSync(path.resolve(import.meta.dirname, '..', 'read-data/artifacts/hosted-experience-authority.ts.txt'), 'utf8');

describe('buyer identity chain', () => {
  it('derives account and signed identity server-side before Product Access', () => {
    expect(authority).toContain('account-session.authorize-transient-session');
    expect(authority).toContain('verifier_target');
    expect(authority).toContain('product-access.authorize-addressed-expiring-value-scope');
    expect(authority).toContain('assertNoBrowserClaims(request, browserPayload)');
  });
});
