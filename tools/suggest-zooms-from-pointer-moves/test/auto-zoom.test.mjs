// Zoom suggestions from pointer telemetry (tools/suggest-zooms-from-pointer-moves/read-data/auto-zoom.mjs, thresholds in auto-zoom.json; moved from Trillion test/auto-zoom.test.mjs; F-0555).
import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFlags, suggestZooms, zoomSettings } from '../read-data/auto-zoom.mjs';

const settings = zoomSettings();
const still = (from, to, x, y, every = 50) => Array.from({ length: Math.floor((to - from) / every) + 1 }, (_, i) => ({ t: from + i * every, type: 'move', x, y }));

test('a pointer that settles gives a zoom whose strength follows the dwell, a click makes it stronger, a wandering pointer gives none', () => {
  const sidecar = { space: 'normalized-source', samples: [
    ...still(0, 400, 0.1, 0.1), { t: 410, type: 'move', x: 0.5, y: 0.5 },
    ...still(500, 1200, 0.5, 0.5),                           // 700 ms: light
    { t: 1250, type: 'move', x: 0.9, y: 0.2 }, ...still(2000, 3400, 0.9, 0.2), { t: 2500, type: 'click', button: 'left', x: 0.9, y: 0.2 }, // 1400 ms + click: strong
    ...Array.from({ length: 30 }, (_, i) => ({ t: 4000 + i * 50, type: 'move', x: (i % 5) * 0.2, y: 0.5 })),
  ] };
  const zooms = suggestZooms(sidecar, settings);
  const near = (zoom, x, y) => Math.hypot(zoom.x - x, zoom.y - y) < 0.01;
  const light = zooms.find(zoom => near(zoom, 0.5, 0.5)); const strong = zooms.find(zoom => near(zoom, 0.9, 0.2));
  assert.equal(light.strength, 'light'); assert.equal(light.zoom, 1.3);
  assert.equal(strong.strength, 'strong'); assert.equal(strong.zoom, 2.0); assert.equal(strong.clicks, 1);
  assert.ok(zooms.every((zoom, i) => i === 0 || zoom.start_ms >= zooms[i - 1].end_ms), 'sorted, none overlap');
  assert.equal(zooms.some(zoom => zoom.start_ms >= 4000), false, 'a wandering pointer gives no zoom');
  assert.deepEqual(suggestZooms(sidecar, settings), zooms, 'deterministic');
  console.log('REAL readback of the suggestions:', JSON.stringify(zooms));
});

test('telemetry that does not say its space is refused, a long stay is split at most_ms, and thresholds come from DATA', () => {
  assert.throws(() => suggestZooms({ samples: [] }, settings), /not normalized-source/);
  assert.throws(() => suggestZooms({ space: 'screen-pixels', samples: [] }, settings), /screen-pixels/);
  assert.deepEqual(suggestZooms({ space: 'normalized-source', samples: [] }, settings), []);
  const long = suggestZooms({ space: 'normalized-source', samples: still(0, 6000, 0.3, 0.3) }, { ...settings, merge_gap_ms: 0 });
  assert.ok(long.length >= 2 && long.every(zoom => zoom.end_ms - zoom.start_ms <= settings.most_ms));
  assert.equal(suggestZooms({ space: 'normalized-source', samples: still(0, 700, 0.3, 0.3) }, { ...settings, least_ms: 800 }).length, 0);
  assert.deepEqual(exportFlags(settings, '/r/t.json', [{ start_ms: 1 }]), ['--zoom-telemetry', '/r/t.json', '--zoom-regions', '[{"start_ms":1}]']);
});
