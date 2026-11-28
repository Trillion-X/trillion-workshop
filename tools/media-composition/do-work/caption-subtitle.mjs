#!/usr/bin/env node
/**
 * file: tools/media-composition/do-work/caption-subtitle.mjs
 *
 * PURPOSE: The subtitle (`edl.subtitles.ass`) for timed caption lines in a caption style, each line optionally placed
 * so that its drawn letters' top or bottom edge sits exactly on one row of the frame. captionAss
 * (read-data/caption-styles.mjs, the one style builder) places a line by its box; the room a font keeps above its
 * capitals and below its baseline differs from font to font, so an edge is placed by measuring, never by a guessed
 * font constant: each line is drawn once, without its shadow, by the renderer the program burns subtitles with
 * (ffmpeg's libass), on a plain black and a plain white frame; its y moves by the rows between the drawn edge and the
 * wanted row; it is drawn again and must land on that row.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. The look is the style's: the subtitle is captionAss's, only each line's y is chosen here.
 * 2. A placed edge is proved: the second drawing must put the edge on the wanted row, else the line is refused.
 * 3. Failures name the line and what was measured, and exit non-zero.
 *
 * Usage: node caption-subtitle.mjs < SPEC.json
 * SPEC.json: {"lines": [{"text", "start", "end", "x"?, "y"?}], "style": <style id | style row>, "width", "height",
 *             "letters": {"edge": "top" | "bottom", "at": 0.5}?,    the row as a fraction of the height
 *             "fontsdir": "/a/folder"?}                             where libass finds the style's font
 * Prints {"result": {"ass", "lines": [{"text", "start", "end", "y", "letters": {"top", "bottom"}}]}} or {"error"}.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captionAss, resolveCaptionStyle } from '../read-data/caption-styles.mjs';

const EDGES = ['top', 'bottom'];

/** The first and last rows where a subtitle draws on a width x height frame at its first moment, or null for none. */
export function drawnRows(ass, { width, height, fontsdir }, folder) {
  const file = join(folder, 'line.ass');
  writeFileSync(file, ass);
  let top = Infinity;
  let bottom = -1;
  for (const [colour, level] of [['black', 0], ['white', 255]]) {
    const drawn = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=${width}x${height}:d=1`,
      '-vf', `ass=${file}${fontsdir ? `:fontsdir=${fontsdir}` : ''}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: width * height * 2 });
    if (drawn.status !== 0 || drawn.stdout.length !== width * height)
      throw new Error(`ffmpeg could not draw the caption: ${String(drawn.stderr).trim().split('\n').pop()}`);
    for (let row = 0; row < height; row += 1) {
      if (drawn.stdout.subarray(row * width, (row + 1) * width).some(value => Math.abs(value - level) > 48)) {
        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
      }
    }
  }
  return bottom < 0 ? null : { top, bottom };
}

/** The subtitle and each line's y; with `letters`, every line's drawn edge is placed on the row `letters.at` names. */
export function captionSubtitle({ lines, style, width, height, letters, fontsdir }) {
  if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) throw new Error('width and height must be whole pixels above 0');
  const resolved = resolveCaptionStyle(style);
  if (!letters) {
    const ass = captionAss(lines, resolved, { width, height });
    if (!ass) throw new Error('no line has words to show');
    return { ass, lines };
  }
  if (!EDGES.includes(letters.edge)) throw new Error(`letters.edge must be one of ${EDGES.join(', ')}, not ${JSON.stringify(letters.edge)}`);
  if (!(Number.isFinite(letters.at) && letters.at >= 0 && letters.at <= 1)) throw new Error('letters.at must be a fraction of the height, 0 to 1');
  const want = Math.round(letters.at * height);
  const bare = { ...resolved, shadow: null };   // the letters alone: a halo is not an edge
  const folder = mkdtempSync(join(tmpdir(), 'caption-subtitle-'));
  try {
    const placed = lines.map((line) => {
      const rows = row => drawnRows(captionAss([{ ...line, start: 0, end: 1, y: row / height }], bare, { width, height }), { width, height, fontsdir }, folder);
      const first = rows(want);
      if (!first) throw new Error(`the line ${JSON.stringify(line.text)} draws no letters`);
      const row = want + (want - first[letters.edge]);
      const got = rows(row);
      if (!got || got[letters.edge] !== want)
        throw new Error(`the line ${JSON.stringify(line.text)} drew its ${letters.edge} edge at row ${got?.[letters.edge]}, not ${want}`);
      return { text: line.text, start: line.start, end: line.end, ...(Number.isFinite(line.x) ? { x: line.x } : {}), y: row / height, letters: got };
    });
    return { ass: captionAss(placed.map(({ letters: _drawn, ...line }) => line), resolved, { width, height }), lines: placed };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  try {
    process.stdout.write(`${JSON.stringify({ result: captionSubtitle(JSON.parse(readFileSync(0, 'utf8'))) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  }
}
