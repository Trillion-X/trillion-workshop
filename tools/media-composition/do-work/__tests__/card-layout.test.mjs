/**
 * file: packages/media-composition/do-work/__tests__/card-layout.test.mjs
 *
 * Tests the generic `card` EDL segment kind: solid-color background + N centered text
 * lines for a duration, driven purely by DATA. Two layers:
 *   (1) PURE unit tests of buildCardLayout — the lavfi color source + one drawtext per
 *       line, centered, escaping-free (textfile + expansion=none), deterministic.
 *   (2) REAL integration — the compositor renders a card and ffprobe confirms the
 *       output dims + duration, proving a hook/CTA card works from DATA alone.
 */

import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCardLayout } from '../card-layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'video-compose.mjs');
const work = tempFolder(join(tmpdir(), 'card-layout-'));

function probe(file, entries) {
  return execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
}
function compose(edl, name) {
  const edlFile = join(work, `${name}.json`);
  const out = join(work, `${name}.mp4`);
  writeFileSync(edlFile, JSON.stringify(edl));
  execFileSync('node', [SCRIPT, '--edl', edlFile, '--out', out], { encoding: 'utf8' });
  return out;
}

const line = (textfile, size, extra = {}) => ({ textfile, size, ...extra });

// ---------------- PURE unit tests ----------------

test('lavfi carries bg, exact dims, fps and duration', () => {
  const { lavfi } = buildCardLayout({
    width: 1080, height: 1920, fps: 30, duration: 2.5, bg: 'black',
    lines: [line('/tmp/a.txt', 92)],
  });
  assert.equal(lavfi, 'color=c=black:s=1080x1920:r=30:d=2.5');
});

test('bg defaults to black when absent', () => {
  const { lavfi } = buildCardLayout({ width: 100, height: 100, fps: 24, duration: 1, lines: [line('/t.txt', 10)] });
  assert.match(lavfi, /^color=c=black:/);
});

test('one drawtext per line, in order', () => {
  const { vf } = buildCardLayout({
    width: 1080, height: 1920, fps: 30, duration: 3,
    lines: [line('/l0.txt', 80), line('/l1.txt', 80), line('/l2.txt', 40)],
  });
  const draws = vf.split(',drawtext=');
  // first chunk starts with `drawtext=`, the rest were split off the leading comma
  assert.equal(vf.startsWith('drawtext='), true);
  assert.equal(draws.length, 3);
  assert.match(vf, /textfile='\/l0\.txt'/);
  assert.match(vf, /textfile='\/l1\.txt'/);
  assert.match(vf, /textfile='\/l2\.txt'/);
});

test('every line is horizontally centered and escaping-free', () => {
  const { vf } = buildCardLayout({
    width: 1080, height: 1920, fps: 30, duration: 3,
    lines: [line('/a.txt', 90, { color: '#d4af37' })],
  });
  assert.match(vf, /x=\(w-text_w\)\/2/);
  assert.match(vf, /expansion=none/);
  assert.match(vf, /fontcolor=#d4af37/);
  // no text= (escaping footgun) anywhere — only textfile=
  assert.equal(/(^|:)text=/.test(vf), false);
});

test('lines are vertically stacked: later line y-expr references a larger offset', () => {
  const { vf } = buildCardLayout({
    width: 1080, height: 1920, fps: 30, duration: 3,
    lines: [line('/a.txt', 100), line('/b.txt', 100)],
  });
  const ys = [...vf.matchAll(/y=([^:]+):fontsize/g)].map((m) => m[1]);
  assert.equal(ys.length, 2);
  // second line's y expression adds a full row height the first does not
  assert.notEqual(ys[0], ys[1]);
  assert.match(ys[1], /\+145/); // 100*(1+0.45) row height appears in the second cursor
});

test('color defaults to white per line', () => {
  const { vf } = buildCardLayout({ width: 100, height: 100, fps: 24, duration: 1, lines: [line('/a.txt', 10)] });
  assert.match(vf, /fontcolor=white/);
});

test('empty lines array throws (a textless card is a bug, fail closed)', () => {
  assert.throws(() => buildCardLayout({ width: 100, height: 100, fps: 24, duration: 1, lines: [] }), /at least one text line/);
});

test('non-positive duration throws', () => {
  assert.throws(() => buildCardLayout({ width: 100, height: 100, fps: 24, duration: 0, lines: [line('/a.txt', 10)] }), /positive duration/);
});

test('domain-blind: arbitrary unicode/symbol text rides through as a textfile path, never inlined', () => {
  // The builder never sees the text itself (only the path), so `:` `%` `'` in content
  // cannot break the graph — proving genericity (no tennis/marketing vocabulary).
  const { vf } = buildCardLayout({
    width: 100, height: 100, fps: 24, duration: 1,
    lines: [line('/weird path/カード 50%: a.txt', 10)],
  });
  assert.match(vf, /textfile='\/weird path\/カード 50%: a\.txt'/);
});

// ---------------- REAL render ----------------

test('compositor renders a real card at exact dims + duration', () => {
  const out = compose({
    encode: { width: 1080, height: 1920, fps: 30, crf: 28, preset: 'ultrafast' },
    base: { kind: 'color', color: 'black' },
    spine: { segments: [
      { id: 'hook', kind: 'card', duration: 2, bg: 'black', lines: [
        { text: 'LINE ONE', size: 90, color: 'white' },
        { text: 'subhead: 50% better', size: 44, color: '#d4af37' },
      ] },
    ] },
  }, 'real-card');
  assert.equal(probe(out, 'stream=width,height').split('\n')[0], '1080,1920');
  assert.ok(Math.abs(Number(probe(out, 'format=duration')) - 2) < 0.4, 'duration ~2s');
});
