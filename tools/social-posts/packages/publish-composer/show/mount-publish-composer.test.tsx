import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  publishComposerDestinationSelector,
  readComposerDestinationsSourceAddress,
} from '@/packages/publish-composer/show/mount-publish-composer';

describe('publish-composer destination source selection', () => {
  it('uses the caller-bounded address through the canonical input', () => {
    expect(readComposerDestinationsSourceAddress({
      destinations_source_address: ' package::owner::destinations ',
    })).toBe('package::owner::destinations');
    expect(publishComposerDestinationSelector({
      destinations_source_address: 'package::owner::destinations',
    })).toEqual({
      input: 'contentDistributionEvidence',
      params: { address: 'package::owner::destinations' },
    });
  });

  it('preserves the standalone package default when no bounded source is supplied', () => {
    expect(readComposerDestinationsSourceAddress({})).toBeNull();
    expect(publishComposerDestinationSelector({})).toBe('contentDistributionEvidence');
  });

  it('keeps one destination projection SSOT and coalesces the caller address over its default', () => {
    const source = JSON.parse(readFileSync(
      path.resolve(process.cwd(), 'packages/publish-composer/things-to-store-and-run.json'),
      'utf8',
    )) as { things: Array<Record<string, any>> };
    const descriptors = source.things.filter(
      (thing) => thing.payload?.input_name === 'contentDistributionEvidence',
    );
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].payload.selected_payload.value_address_label).toEqual({
      op: 'coalesce',
      values: [
        { from: 'params', op: 'path', path: ['address'] },
        'content-distribution-content-media-evidence',
      ],
    });
    expect(descriptors[0].payload.selected_payload.value.projection.fields).toHaveLength(11);
  });

  it('builds native entry bytes from relative or proposal-resolved source paths', () => {
    const source = JSON.parse(readFileSync(
      path.resolve(process.cwd(), 'packages/publish-composer/things-to-store-and-run.json'),
      'utf8',
    )) as { things: Array<Record<string, any>> };
    const nativeBuild = source.things.find(
      (thing) => thing.name === 'built-show-ios-jscore-mount-publish-composer-jscore',
    );
    const script = nativeBuild?.build?.process?.argv?.[2];
    expect(script).toContain('path.resolve(request.package_root, request.source_file)');
    expect(script).not.toContain('path.join(request.package_root, request.source_file)');
  });
});
