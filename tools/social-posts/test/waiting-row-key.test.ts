// The one-at-a-time row is keyed by its row's id. Keyed only by its group, the component that decided one row keeps that
// row's busy state for the next row, and a Skip pressed on the next row then decides the row before it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

const screenSource = readFileSync(new URL('../web/src/workspace/pieces-screen.tsx', import.meta.url), 'utf8');

describe('the one-at-a-time waiting row', () => {
  it('is keyed by the id of the row it shows, so the next row starts with no busy state', () => {
    const keyed = screenSource.match(/<OneWaiting key=\{(.*?)\} group=/);
    expect(keyed).not.toBeNull();
    expect(keyed![1]).toContain('group.source.id');
  });
});
