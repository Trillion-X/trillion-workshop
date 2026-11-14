import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageData = JSON.parse(
  readFileSync(path.join(packageRoot, 'things-to-store-and-run.json'), 'utf8'),
) as { things: Array<{ address?: string }> };

describe('ideas package DATA ownership', () => {
  it('declares each resolved address exactly once', () => {
    const addresses = packageData.things
      .map((thing) => thing.address)
      .filter((address): address is string => typeof address === 'string');
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses.filter((address) => address === 'package::ideas::published-records')).toHaveLength(1);
  });
});
