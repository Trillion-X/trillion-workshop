// A long follow track (a 70 s reel tracked every 0.125 s) must render: ffmpeg refuses an expression nested past
// about 100 levels, which the old if-chain hit at about 13 seconds of track ("The edit could not be rendered").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseByThreshold } from '../do-work/choose-by-threshold.mjs';

const chain = (v, b, p) => b.reduceRight((rest, at, i) => `if(lt(${v},${at}),${p[i]},${rest})`, String(p[p.length - 1]));
const evaluate = (expr, v) => Function('v', `const lt=(a,b)=>a<b; const iff=(c,a,b)=>c?a:b; return ${expr.replaceAll('if(', 'iff(')};`)(v);

test('picks the same piece as the chain for every value, at log2 depth', () => {
  const thresholds = Array.from({ length: 553 }, (_, i) => i * 0.125);
  const pieces = Array.from({ length: 554 }, (_, i) => i);
  const tree = chooseByThreshold('v', thresholds, pieces);
  for (const v of [-1, 0, 0.0625, 0.125, 3.3, 68.9, 69, 1000]) assert.equal(evaluate(tree, v), evaluate(chain('v', thresholds, pieces), v));
  let depth = 0, most = 0;
  for (const c of tree) { if (c === '(') most = Math.max(most, ++depth); if (c === ')') depth -= 1; }
  assert.ok(most < 40, `nested ${most} deep`);
});

test('a 70 s follow crop renders through video-compose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'follow-'));
  try {
    const source = join(dir, 'wide.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=8:duration=70', '-pix_fmt', 'yuv420p', source]);
    const track = Array.from({ length: 560 }, (_, i) => ({ t: i * 0.125, cx: 0.5 + 0.4 * Math.sin(i / 20), cy: 0.5 }));
    const edl = { encode: { width: 90, height: 160 }, spine: { segments: [{ kind: 'clip', id: 'r', source, reframe: { aspect_w: 9, aspect_h: 16, track } }] } };
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('../do-work/render-an-edit.mjs', import.meta.url)), '--edl', JSON.stringify(edl), '--output', join(dir, 'tall.mp4')], { encoding: 'utf8' });
    const made = JSON.parse(out.trim().split('\n').pop());
    assert.equal(made.width, 90);
    assert.equal(made.height, 160);
    assert.ok(Math.abs(made.duration_seconds - 70) < 0.5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
