import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readExportArtifact } from './MediaOutputPanel';

const source = readFileSync(
  join(process.cwd(), 'packages/media-composition/show/components/MediaOutputPanel.tsx'),
  'utf8',
);

describe('media export visible copy boundary', () => {
  it('routes raw renderer failures through the shared plain-language gate', () => {
    expect(source).toContain('sanitizeErrorText(');
    expect(source).not.toMatch(/`Export failed:\s*\$\{detail\}`/);
  });

  it('accepts only a complete playable MP4 result', () => {
    const video = {
      cas_address: '1f:manifest',
      multihash: '1f:integrity',
      byte_length: 42,
      media_type: 'video/mp4',
    };

    expect(readExportArtifact({ output: { artifacts: [video] } })).toEqual(video);
    expect(readExportArtifact({ artifacts: [{ ...video, cas_address: '' }] })).toBeNull();
    expect(readExportArtifact({ artifacts: [{ ...video, multihash: '' }] })).toBeNull();
    expect(readExportArtifact({ artifacts: [{ ...video, byte_length: 0 }] })).toBeNull();
    expect(readExportArtifact({ artifacts: [{ ...video, byte_length: 1.5 }] })).toBeNull();
    expect(readExportArtifact({ artifacts: [{ ...video, media_type: 'video/webm' }] })).toBeNull();
  });
});
