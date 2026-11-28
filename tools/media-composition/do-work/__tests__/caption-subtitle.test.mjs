/**
 * file: tools/media-composition/do-work/__tests__/caption-subtitle.test.mjs
 *
 * A caption line placed by its drawn letters: drawn by the renderer the program burns subtitles with (ffmpeg's libass),
 * each line's top or bottom letter edge lands on the wanted row, whatever its letters; the look stays the style's; a
 * wrong edge is refused; without `letters` the subtitle is the style builder's own. Skips when ffmpeg has no libass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { captionSubtitle, drawnRows } from '../caption-subtitle.mjs';
import { captionAss } from '../../read-data/caption-styles.mjs';

const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
const libass = filters.status === 0 && /\bass\b/.test(filters.stdout) ? false : 'ffmpeg with libass is needed';
const frame = { width: 360, height: 640 };
const style = { id: 'white-words-light-up', reveal: 'line' };
const lines = [{ text: 'Nov 2023', start: 0, end: 2, x: 0.5 }, { text: 'Jan 2025', start: 2, end: 4, x: 0.5 }];

test('each line\'s drawn top letter edge lands on the wanted row, the halo kept', { skip: libass }, () => {
  const got = captionSubtitle({ lines, style, ...frame, letters: { edge: 'top', at: 0.5 } });
  const work = tempFolder(join(tmpdir(), 'caption-subtitle-'));
  for (const line of got.lines) {
    assert.equal(line.letters.top, 320);
    const alone = captionAss([{ ...line, start: 0, end: 1 }], { ...style, shadow: null }, frame);
    assert.equal(drawnRows(alone, frame, work).top, 320);           // drawn again by itself: on the row
  }
  assert.match(got.ass, /\\blur\d/);                                 // the style's soft halo is still drawn
  assert.deepEqual(got.lines.map(line => [line.start, line.end]), [[0, 2], [2, 4]]);
});

test('a bottom edge is placed the same way', { skip: libass }, () => {
  const got = captionSubtitle({ lines: lines.slice(0, 1), style, ...frame, letters: { edge: 'bottom', at: 0.25 } });
  assert.equal(got.lines[0].letters.bottom, 160);
});

test('a wrong edge or row is refused, and no letters means the style builder\'s own subtitle', () => {
  assert.throws(() => captionSubtitle({ lines, style, ...frame, letters: { edge: 'middle', at: 0.5 } }), /letters\.edge/);
  assert.throws(() => captionSubtitle({ lines, style, ...frame, letters: { edge: 'top', at: 2 } }), /letters\.at/);
  assert.equal(captionSubtitle({ lines, style, ...frame }).ass, captionAss(lines, style, frame));
});
