import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

const artifacts = path.resolve(import.meta.dirname, '..', 'read-data', 'artifacts');
const source = (name: string) => readFileSync(path.join(artifacts, name), 'utf8');
const authority = source('hosted-experience-authority.ts.txt');

describe('buyer network escape corpus', () => {
  it('binds manifest, byte, data, subscription, and target routes to the one shared resolver', () => {
    const protectedRoutes = [
      'app-api-experience-manifest-route.ts.txt', 'app-api-experience-bytes-route.ts.txt',
      'app-api-experience-data-route.ts.txt', 'app-api-experience-subscriptions-route.ts.txt',
      'hosted-target-route.ts.txt',
    ];
    for (const route of protectedRoutes) {
      expect(source(route)).toContain('resolveHostedExperienceAuthority');
      expect(source(route)).toContain('safeAuthorityError');
      expect(source(route)).toContain('Cache-Control');
      expect(source(route)).toContain('no-store');
    }
  });

  it('denies the direct URL/hash/data/subscription/target/query claim corpus before owner data is reachable', () => {
    for (const claim of ['access_ref', 'grant', 'grant_ref', 'policy', 'policy_ref', 'principal', 'principal_ref', 'scope', 'session', 'session_ref']) {
      expect(authority).toContain(`"${claim}"`);
    }
    expect(authority).toContain('assertNoBrowserClaims(request, browserPayload)');
    expect(authority).toContain('requireManifestRef(authority, "data_address_refs", requestedRef)');
    expect(authority).toContain('requireManifestRef(authority, "subscription_refs", ref)');
    // ⛔ THIS ASSERTED A CALL SPELLING THAT NEVER EXISTED, and it failed the day the suite was
    // first declared as a check (2026-09-10). `requireManifestRef(authority, "target_refs", target)`
    // appears nowhere; the two lines above it are real, so the pattern was extended to a third
    // route by analogy and never run. The authority it MEANT to require is present and is
    // stricter than the call it looked for: entryProjectionTarget resolves the selected ref
    // against the manifest's target_refs and denies with 404 unless EXACTLY ONE candidate
    // matches, so a target claim cannot be smuggled past it either. Asserting the guarantee
    // rather than one function name is also what stops the next refactor breaking this line
    // while the security property holds.
    expect(authority).toContain('manifestRefs(authority.authorityManifest, "target_refs")');
    expect(authority).toContain('if (matches.length !== 1) deny(');
    expect(authority).toContain('const member = authority.projectedFiles.find');
    expect(authority).toContain('if (!member) deny()');
  });

  it('checks status, current access, and sealed-closure membership on every protected operation', () => {
    expect(authority).toContain('publication.status !== "active"');
    expect(authority).toContain('operation,');
    expect(authority).toContain('product-access.authorize-addressed-expiring-value-scope');
    expect(authority).toContain('verify-applied-proof');
    expect(authority).toContain('if (bytes.byteLength !== member.byte_count');
    expect(source('hosted-target-carrier-client.tsx.txt')).toContain('Every retry re-authorizes');
    expect(source('hosted-target-carrier-client.tsx.txt')).toContain('cache: "no-store"');
  });

  it('does not convert hostile surface query strings into navigation authority', () => {
    const page = source('app-page.tsx.txt');
    expect(page).not.toMatch(/params\.surface|searchParams\.surface|[?&]surface=/);
    expect(page).toContain('BITFIELD_PUBLICATION_REF');
    expect(page).toContain('function isAllowedBuyerQuery');
    expect(page).toContain('Object.keys(params).every((key) => key === "token")');
    expect(page).toContain('if (!isAllowedBuyerQuery(params))');
    expect(page).toContain('signedEvidence={first(params.token)}');
  });
});
