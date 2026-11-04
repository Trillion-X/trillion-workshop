/**
 * #231 Smart caption placement (subject-avoidance): the #1 vertical-reel caption complaint is the caption block
 * landing ON the speaker's face/body. This DECIDES where the caption goes by reading the subject track and
 * placing the block in the CLEAR region (subject high in frame -> captions bottom; subject low -> captions top).
 * It composes the existing detect-track producer (#101, brightness-centroid `[{t,x,y}]`) with the ASS caption
 * margins the karaoke authorer (#230) already exposes, so the output is just `{alignment, marginV, edge}` opts
 * fed straight into karaokeAss. ZERO new render code (L069): placement is DATA (an ASS alignment + margin); a
 * face/pose detector is a smarter drop-in producer emitting the SAME track shape (L090). No god package: it does
 * not track (detect-track does) and does not render (video-compose does), it only DECIDES.
 */
import { spawnSync } from 'node:child_process';

const round = (n) => Math.round(n);
function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0.5;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * PURE: decide caption placement from a subject track. `track` is [{t,x,y}] with y normalized 0..1 (0 = top).
 * When the subject sits in the TOP half the caption goes to the BOTTOM (ASS alignment 2), and vice versa
 * (alignment 8). `marginV` is the gap from that aligned edge, a fraction of the frame height.
 * @returns {{edge:'top'|'bottom', alignment:number, marginV:number, subjectY:number}}
 */
export function captionPlacement(track, { frameHeight = 1920, marginFrac = 0.08 } = {}) {
  const ys = (Array.isArray(track) ? track : []).map((p) => (p && Number.isFinite(p.y) ? p.y : null)).filter((v) => v != null);
  const subjectY = ys.length ? median(ys) : 0.5;
  const marginV = Math.max(0, round((Number.isFinite(frameHeight) ? frameHeight : 1920) * Math.max(0, marginFrac)));
  // Subject in the TOP half -> put captions at the BOTTOM (clear region), and the reverse. A tie defaults to
  // bottom (the caption convention) so a centered subject still reads.
  return subjectY <= 0.5
    ? { edge: 'bottom', alignment: 2, marginV, subjectY }
    : { edge: 'top', alignment: 8, marginV, subjectY };
}

/** Run detect-track on a video and decide placement (the composition). Returns the same placement object. */
export function placeCaptionsForVideo(file, { marginFrac = 0.08, stepMs = 150, grid = 16, threshold = 128 } = {}) {
  const trackScript = new URL('./detect-track.mjs', import.meta.url).pathname;
  const res = spawnSync('node', [trackScript, file, String(stepMs), String(grid), String(threshold)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let track = [], frameHeight = 1920;
  try {
    const out = JSON.parse(res.stdout || '{}');
    track = Array.isArray(out.path) ? out.path : [];
    if (Number.isFinite(out.height)) frameHeight = out.height;
  } catch { /* fall through to the centered default */ }
  return captionPlacement(track, { frameHeight, marginFrac });
}

// CLI: node place-captions.mjs <video> [--margin-frac F] -> prints {edge,alignment,marginV,subjectY}
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error('usage: place-captions.mjs <video> [--margin-frac F]'); process.exit(2); }
  const mfIdx = process.argv.indexOf('--margin-frac');
  const marginFrac = mfIdx > 0 ? Number(process.argv[mfIdx + 1]) : 0.08;
  process.stdout.write(JSON.stringify(placeCaptionsForVideo(file, { marginFrac })) + '\n');
}
