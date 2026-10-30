// tools/media-composition/do-work/detect-track.mjs
/**
 * #101 Motion-track PRODUCER. Follows a bright subject through a video with ffmpeg and emits its
 * normalized 0..1 center per sampled frame as a track `[{t,x,y}]`. It is a PRODUCER: it only MEASURES
 * (the compositor stays blind). The caller attaches the track to an overlay (text/image), and the
 * render binds that overlay's x/y to the track via the piecewise position expression it already uses
 * for the #70 reframe follow, so a label/emoji/blur FOLLOWS the subject with zero new render code (L069).
 * The centroid is the brightness-weighted center of high-luma cells (a face/person detector is a
 * smarter drop-in producer that emits the SAME track shape).
 *
 * Usage: node detect-track.mjs <video-path> [stepMs=150] [grid=16] [threshold=128]
 * Output (stdout, JSON): { path: [{t,x,y}], width, height, step_ms, grid }
 */
import { spawnSync } from 'node:child_process';

const videoPath = process.argv[2];
const stepMs = Number.isFinite(Number(process.argv[3])) && Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 150;
const grid = Number.isFinite(Number(process.argv[4])) && Number(process.argv[4]) > 0 ? Math.round(Number(process.argv[4])) : 16;
const threshold = Number.isFinite(Number(process.argv[5])) ? Number(process.argv[5]) : 128;
if (!videoPath) {
  process.stderr.write('[detect-track] usage: node detect-track.mjs <video-path> [stepMs] [grid] [threshold]\n');
  process.exit(2);
}

const ffmpegBin = process.env.MEDIA_FFMPEG_BIN ?? 'ffmpeg';
const ffprobeBin = process.env.MEDIA_FFPROBE_BIN ?? 'ffprobe';

const probe = spawnSync(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', videoPath], { encoding: 'utf8' });
const [srcW, srcH] = (probe.stdout ?? '').trim().split('x').map(Number);

// Sample the video to grid x grid gray frames at fps = 1000/stepMs; raw gray bytes on stdout.
const fps = 1000 / stepMs;
const res = spawnSync(ffmpegBin, [
  '-hide_banner', '-i', videoPath,
  '-vf', `fps=${fps},scale=${grid}:${grid},format=gray`,
  '-f', 'rawvideo', '-',
], { maxBuffer: 256 * 1024 * 1024 });
const buf = res.stdout;
if (!buf || buf.length < grid * grid) {
  process.stderr.write('[detect-track] no frames sampled\n');
  process.exit(1);
}

// The subject centroid of one gray grid: brightness-weighted mean of cells above threshold (0..1).
const centroid = (frame) => {
  let sw = 0; let sx = 0; let sy = 0;
  for (let r = 0; r < grid; r += 1) {
    for (let c = 0; c < grid; c += 1) {
      const v = frame[r * grid + c];
      if (v < threshold) continue;
      const w = v - threshold;
      sw += w; sx += w * (c + 0.5); sy += w * (r + 0.5);
    }
  }
  if (sw <= 0) return { x: 0.5, y: 0.5 };
  return { x: Number((sx / sw / grid).toFixed(4)), y: Number((sy / sw / grid).toFixed(4)) };
};

const frameBytes = grid * grid;
const path = [];
const frames = Math.floor(buf.length / frameBytes);
for (let i = 0; i < frames; i += 1) {
  const frame = buf.subarray(i * frameBytes, (i + 1) * frameBytes);
  const c = centroid(frame);
  path.push({ t: Number((i / fps).toFixed(3)), x: c.x, y: c.y });
}

process.stdout.write(`${JSON.stringify({ path, width: srcW || null, height: srcH || null, step_ms: stepMs, grid })}\n`);
