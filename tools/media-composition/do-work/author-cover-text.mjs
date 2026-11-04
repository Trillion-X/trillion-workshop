/**
 * #234 Cover-text / thumbnail-title authorer (the bold clickbait title burned on the THUMBNAIL, the top social
 * CTR lever). extract-poster (#224 pick + extract) produces a plain frame; nothing burned a TITLE onto it. This
 * burns a big centered title onto a poster IMAGE via drawtext, the same injection-safe textfile+drawtext approach
 * the video captions/labels/cards use, so no new render engine (L069) and the compositor stays blind (L090). It is
 * distinct from a card (a video SEGMENT) and from captions (on the VIDEO): this is the still COVER a gallery/feed
 * shows. All DATA is sanitized into the filter grammar (safeColor -> 0xRRGGBB, clamped+rounded size, title via a
 * textfile so no `:`/`'`/`%` can break the graph).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Sanitize a color into a drawtext-safe token: #rrggbb / rrggbb -> 0xRRGGBB (optional @opacity), a plain word
// (letters only) passes as a named color, anything else falls back. No `:` or `'` can survive (injection-safe).
export function safeColor(c, fallback = 'white') {
  if (typeof c !== 'string') return fallback;
  const withOp = c.match(/^#?([0-9a-fA-F]{6})(?:@(\d(?:\.\d+)?))?$/);
  if (withOp) return `0x${withOp[1].toUpperCase()}${withOp[2] != null ? `@${withOp[2]}` : ''}`;
  if (/^[a-zA-Z]+(?:@\d(?:\.\d+)?)?$/.test(c)) return c;
  return fallback;
}

/**
 * PURE: the drawtext fragment for a cover title read from `textfile`. `xFrac`/`yFrac` (0..1) place the box; the
 * title is centered horizontally by default. box=1 draws a legibility plate behind the text.
 */
export function coverTextDrawFilter({ textfile, size, color, box = true, boxColor, xFrac = 0.5, yFrac = 0.72 }) {
  const fs = clamp(Math.round(Number.isFinite(size) ? size : 56), 8, 4096);
  const fx = clamp(Number.isFinite(xFrac) ? xFrac : 0.5, 0, 1);
  const fy = clamp(Number.isFinite(yFrac) ? yFrac : 0.72, 0, 1);
  const parts = [
    `textfile='${textfile}'`, 'expansion=none',
    `x=(w-text_w)*${fx}`, `y=(h-text_h)*${fy}`,
    `fontsize=${fs}`, `fontcolor=${safeColor(color, 'white')}`,
  ];
  if (box !== false) parts.push('box=1', `boxcolor=${safeColor(boxColor, 'black@0.5')}`, `boxborderw=${Math.round(fs * 0.35)}`);
  return `drawtext=${parts.join(':')}`;
}

/** Burn a cover title onto a poster image. Writes the title to a textfile (escaping-free) and runs ffmpeg. */
export function burnCoverText(posterIn, title, posterOut, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cover-'));
  const tf = join(dir, 'title.txt');
  writeFileSync(tf, String(title == null ? '' : title));
  const vf = coverTextDrawFilter({ ...opts, textfile: tf });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', posterIn, '-vf', vf, '-frames:v', '1', posterOut], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`[cover-text] ffmpeg failed: ${(r.stderr || '').slice(-300)}`);
  return posterOut;
}

// CLI: node author-cover-text.mjs <poster-in> <out> --title "TEXT" [--size N --color #hex --box-color #hex --y-frac F]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [posterIn, out, ...rest] = process.argv.slice(2);
  if (!posterIn || !out) { console.error('usage: author-cover-text.mjs <poster-in> <out> --title "TEXT" [--size N --color #hex --box-color #hex --y-frac F]'); process.exit(2); }
  const opt = {}; let title = '';
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = rest[i + 1];
    if (k === '--title') title = v;
    else if (k === '--size') opt.size = Number(v);
    else if (k === '--color') opt.color = v;
    else if (k === '--box-color') opt.boxColor = v;
    else if (k === '--y-frac') opt.yFrac = Number(v);
  }
  burnCoverText(posterIn, title, out, opt);
  process.stdout.write(JSON.stringify({ out }) + '\n');
}
