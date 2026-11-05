import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';

import { decodeCanonicalArtifactRef, evidencePayloads, readEvidenceProjection } from '../../../read-data/content-media-evidence.ts';

describe('content media evidence projection', () => {
  it('projects maintained evidence rows by role instead of package-specific kind code', () => {
    const projection = readEvidenceProjection([
      {
        address: 'package::alpha::config',
        role: 'config',
        source_package: 'alpha',
        payload: {
          kind: 'content-media.evidence-pipeline.config',
          package: 'alpha',
          roles: {
            requests: ['user.named.request'],
            results: ['native.tool.output', 'human.corrected.output'],
          },
          proof_gates: ['CPD-10F'],
        },
      },
      {
        address: 'request::one',
        role: 'requests',
        payload: { kind: 'user.named.request', id: 'request-1', value: 'transcribe this' },
      },
      {
        address: 'result::one',
        role: 'results',
        payload: { kind: 'native.tool.output', id: 'result-1', value: 'hello' },
      },
      {
        address: 'result::two',
        role: 'results',
        payload: { kind: 'human.corrected.output', id: 'result-2', value: 'hello world' },
      },
      {
        address: 'unrelated::one',
        role: 'legacy',
        payload: { kind: 'audio-transcription.request', id: 'old-hardcoded-kind' },
      },
    ], 'alpha');

    expect(evidencePayloads<{ id: string }>(projection, 'requests').map((payload) => payload.id)).toEqual([
      'request-1',
    ]);
    expect(evidencePayloads<{ id: string }>(projection, 'results').map((payload) => payload.id)).toEqual([
      'result-1',
      'result-2',
    ]);
    expect(projection.blockers.map((blocker) => blocker.code)).toEqual(['content-media.proof-gate.pending']);
  });

  it('does not borrow another package config with matching roles', () => {
    const projection = readEvidenceProjection([
      {
        address: 'package::beta::config',
        source_package: 'beta',
        payload: {
          kind: 'content-media.evidence-pipeline.config',
          package: 'beta',
          roles: { requests: ['beta.request'] },
        },
      },
      {
        address: 'request::one',
        role: 'requests',
        payload: { kind: 'beta.request', id: 'request-1' },
      },
    ], 'alpha');

    expect(projection.config).toBeNull();
    expect(evidencePayloads<{ id: string }>(projection, 'requests').map((payload) => payload.id)).toEqual([
      'request-1',
    ]);
    expect(projection.blockers.map((blocker) => blocker.code)).toEqual([
      'content-media.evidence-config.missing',
    ]);
  });

  it('emits machine-readable blockers when the maintained feed is absent', () => {
    const projection = readEvidenceProjection(null, 'alpha');

    expect(projection.config).toBeNull();
    expect(projection.rowsByRole).toEqual({});
    expect(projection.blockers.map((blocker) => blocker.code)).toEqual([
      'content-media.evidence-projection.missing',
      'content-media.evidence-config.missing',
    ]);
  });
});

describe('canonical artifact reference', () => {
  const ref = (overrides: Record<string, unknown> = {}) => ({
    kind: 'canonical-artifact-ref/v1',
    payload_address: 'artifact::proof',
    payload_address_mode: 'address_bytes',
    integrity_hash: '1f:abc',
    byte_length: 3,
    media_type: 'application/octet-stream',
    display_name: 'proof.bin',
    provenance: { source_ref: 'source:test' },
    ...overrides,
  });

  it.each(['address_bytes', 'addressed_chunks'])('accepts the explicit %s mode', (payload_address_mode) => {
    expect(decodeCanonicalArtifactRef(ref({ payload_address_mode }))?.payload_address_mode).toBe(payload_address_mode);
  });

  it.each([
    ['missing mode', { payload_address_mode: undefined }],
    ['negative size', { byte_length: -1 }],
    ['overflow size', { byte_length: Number.MAX_SAFE_INTEGER }],
    ['traversal name', { display_name: '../proof.md' }],
    ['HTML active content', { media_type: 'text/html' }],
    ['SVG active content', { media_type: 'image/svg+xml' }],
    ['missing integrity', { integrity_hash: '' }],
  ])('rejects %s', (_label, invalid) => {
    expect(decodeCanonicalArtifactRef(ref(invalid))).toBeNull();
  });

  it('accepts a zero-byte file without inventing absence', () => {
    expect(decodeCanonicalArtifactRef(ref({ byte_length: 0 }))?.byte_length).toBe(0);
  });
});
