import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

const artifacts = path.resolve(import.meta.dirname, '..', 'read-data', 'artifacts');
const source = (name: string) => readFileSync(path.join(artifacts, name), 'utf8');
const authority = source('hosted-experience-authority.ts.txt');

describe('buyer browser-context isolation', () => {
  it('uses request-scoped cookie/session authority rather than browser-visible grant or profile claims', () => {
    expect(authority).toContain('function cookieEvidence(request: Request)');
    expect(authority).toContain('account-session.authorize-transient-session');
    expect(authority).toContain('principal_ref: identity.principal_ref');
    expect(authority).toContain('session_ref: identity.session_ref');
    expect(authority).toContain('assertNoBrowserClaims(request, browserPayload)');
    expect(authority).not.toContain('localStorage');
    expect(authority).not.toContain('indexedDB');
  });

  it('makes the next operation observe cookie clearing, replacement, copied claims, and account A/B boundaries', () => {
    expect(authority).toContain('const cookie = request.headers.get("cookie")');
    expect(authority).toContain('if (!isRecord(reply) || reply.authorized !== true)');
    expect(authority).toContain('product-access.authorize-addressed-expiring-value-scope');
    expect(authority).toContain('required_access_refs: requiredAccessRefs');
    expect(authority).toContain('randomUUID()');
    expect(authority).toContain('anonymous-request:');
  });

  it('keeps parallel tabs and private contexts response-isolated through no-store request transport', () => {
    const transport = source('hosted-target-carrier-client.tsx.txt');
    const surface = source('hosted-surface-client.tsx.txt');
    expect(transport).toContain('credentials: "same-origin"');
    expect(transport).toContain('cache: "no-store"');
    expect(transport).toContain('private readonly publicationRef: string');
    expect(transport).toContain('this.snapshots.clear()');
    expect(transport).not.toContain('localStorage');
    expect(transport).not.toContain('sessionStorage');
    expect(transport).not.toContain('BroadcastChannel');
    expect(transport).toContain('this.notifyAuthorityDenied()');
    expect(transport).toContain('onAuthorityDenied(callback');
    expect(surface).toContain('if (accessDenied)');
    expect(surface).toContain('Access is no longer active.');
  });
});
