import { blake3 } from '@noble/hashes/blake3.js';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
const artifactRoot = path.join(packageRoot, 'read-data', 'artifacts');
const packageData = JSON.parse(readFileSync(path.join(packageRoot, 'things-to-store-and-run.json'), 'utf8')) as {
  things: Array<{ source_path?: unknown; type?: unknown }>;
};
const artifactNames = readdirSync(artifactRoot).filter((name) => name.endsWith('.txt')).sort();
const artifact = (name: string) => readFileSync(path.join(artifactRoot, name), 'utf8');
const contentHashHex = (text: string) => Buffer.from(blake3(new Uint8Array(Buffer.from(text)))).toString('hex');

describe('buyer artifact absence', () => {
  it('maps every source-bound buyer artifact exactly once in package DATA and records stable proposal hashes', () => {
    const mapped = packageData.things
      .filter((thing) => thing.type === 'stored_bytes' && typeof thing.source_path === 'string')
      .map((thing) => thing.source_path as string)
      .filter((sourcePath) => sourcePath.startsWith('read-data/artifacts/'))
      .map((sourcePath) => sourcePath.slice('read-data/artifacts/'.length))
      .sort();
    expect(mapped).toEqual(artifactNames);
    expect(new Set(mapped).size).toBe(mapped.length);
    for (const name of artifactNames) expect(contentHashHex(artifact(name))).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ships a selected-experience shell, not Studio, catalog, or seller authoring bytes', () => {
    const proposedBytes = artifactNames.map(artifact).join('\n');
    for (const forbidden of [
      'screen-arrangement', 'package catalog', 'PackageCatalog', 'SurfaceRegistry',
      'seller toolbar', 'Share/Sell', 'sidebar', 'browse packages',
    ]) expect(proposedBytes).not.toContain(forbidden);
    expect(artifact('hosted-surface-page.tsx.txt')).toContain('data-buyer-experience');
    expect(artifact('hosted-surface-client.tsx.txt')).toContain('webpackIgnore: true');
    expect(artifact('hosted-surface-client.tsx.txt')).toContain('entryUrl(publicationRef, path)');
  });

  it('keeps selected bytes source-bound and dynamically loaded only after manifest authority', () => {
    const client = artifact('hosted-surface-client.tsx.txt');
    const authority = artifact('hosted-experience-authority.ts.txt');
    expect(artifact('hosted-surface-page.tsx.txt')).toContain('publicExperienceManifest');
    expect(client).toContain('entry_byte_path');
    expect(client).not.toMatch(/from\s+["'][^"']*(poker|workout|studio|catalog)/i);
    expect(authority).toContain('verifiedApplyProof');
    expect(authority).toContain('readAuthorizedBytes');
    expect(authority).toContain('makeHashCodeHexFromBytes(bytes) !== member.multihash');
  });
});
