import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRenderDimensions, RENDER_FRAME_PRESETS } from '../resolve-render-dimensions.mjs';

test('named export resolutions resolve to exact canvas dimensions, including 8K', () => {
  assert.deepEqual(resolveRenderDimensions({ resolution: '1080p' }), { width: 1920, height: 1080 });
  assert.deepEqual(resolveRenderDimensions({ resolution: '4k' }), { width: 3840, height: 2160 });
  assert.deepEqual(resolveRenderDimensions({ resolution: '8k' }), { width: 7680, height: 4320 });
  assert.deepEqual(Object.keys(RENDER_FRAME_PRESETS), ['1080p', '4k', '8k']);
});

test('Source uses the first source dimensions and does not apply an output-size cap', () => {
  assert.deepEqual(resolveRenderDimensions({ resolution: 'source' }, { width: 7680, height: 4320 }), {
    width: 7680,
    height: 4320,
  });
  assert.deepEqual(resolveRenderDimensions({ width: 4096, height: 2160 }), { width: 4096, height: 2160 });
});

test('unknown resolution and unavailable Source dimensions fail clearly', () => {
  assert.throws(() => resolveRenderDimensions({ resolution: '720p' }), /unsupported output resolution/);
  assert.throws(() => resolveRenderDimensions({ resolution: 'source' }), /requires readable dimensions/);
});
