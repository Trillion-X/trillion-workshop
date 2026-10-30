#!/usr/bin/env node
/**
 * file: packages/media-composition/do-work/extract-poster.mjs
 *
 * PURPOSE: The generic poster-frame extraction capability. Given a video
 * (mp4 or any ffmpeg-readable container) referenced as a CAS ref, an http(s)
 * URL, or a local file path, plus a timestamp (a fraction of the duration or
 * an explicit number of seconds), it extracts ONE frame with ffmpeg, writes it
 * as a jpg, and computes that jpg's content-addressed CAS identity
 * (poster_ref = a `1f:` BLAKE3 multihash via makeHashCodeHexFromBytes). The
 * poster jpg becomes a REAL thumbnail for a finished video record, killing the
 * decorative `ui/show/media-thumb/MediaThumb.tsx` placeholder.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. The CAS identity is BLAKE3 (makeHashCodeHexFromBytes), NEVER sha256.
 *    A `1f:<sha256hex>` parses but can never exist in CAS (see CLAUDE.md).
 * 2. Deterministic: one frame, single thread, fixed qscale and scale, seek
 *    before input, so the SAME (video, timestamp, width, quality) yields
 *    byte-identical jpg bytes and therefore an identical poster_ref every run.
 * 3. No machine paths in DATA: the video and the hash library are supplied as
 *    self-describing refs / an env or arg, never a hardcoded absolute path.
 * 4. Idempotent: an existing poster_ref that already resolves in CAS short
 *    circuits both the extraction and any store, so re-runs do no work.
 * 5. Workflow-native (L136): runnable as one `kind:"ask" name:"compute.process"`
 *    step. The jpg output is content-addressed into CAS by the process step's
 *    `outputs[].storage:"addressed_chunks"` declaration (the same seam the
 *    video-compose mp4 uses); the engine's cas_address equals poster_ref for
 *    those exact bytes. No bespoke poller, no launchd, no filesystem watcher.
 *
 * Usage:
 *   node extract-poster.mjs --video <ref> [--at <fraction|Ns>] [--width <px>]
 *     [--quality <2..31>] [--out <poster.jpg>] [--result <result.json>]
 *     [--workdir <dir>] [--shell <url>] [--existing-poster-ref <1f:...>]
 *     [--hash-lib <slot-protocol-js/index.js>]
 *
 * --video is SELF-DESCRIBING (L090): a `1f:` CAS ref is fetched from
 * <shell>/cas/<ref>, an http(s) URL is fetched, anything else is a file path.
 * --at is SELF-DESCRIBING: a value ending in `s` (e.g. `3.5s`) is absolute
 * seconds; a bare number in [0,1] is a fraction of the probed duration
 * (default 0.25). Output on stdout is one JSON line the workflow consumes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ''), argv[i + 1]);

const VIDEO = args.get('video');
if (!VIDEO) {
  console.error('usage: extract-poster.mjs --video <1f:ref|http(s)|path> [--at <fraction|Ns>] [--width <px>] [--quality <2..31>] [--out <poster.jpg>] [--result <result.json>] [--shell <url>] [--existing-poster-ref <1f:...>]');
  process.exit(2);
}

// ffmpeg / ffprobe: prefer an explicit env, then the homebrew install, then PATH.
const FFMPEG = process.env.FFMPEG_BIN
  ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE = process.env.FFPROBE_BIN
  ?? (existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');

const WORKDIR = args.get('workdir') ?? mkdtempSync(join(tmpdir(), 'extract-poster-'));
const OUT = args.get('out') ?? join(WORKDIR, 'poster.jpg');
const RESULT = args.get('result') ?? join(WORKDIR, 'result.json');
const WIDTH = args.has('width') ? Number(args.get('width')) : 640; // 0 = keep native size
const QUALITY = args.has('quality') ? Number(args.get('quality')) : 3; // mjpeg -q:v, 2 best .. 31 worst
const SHELL = args.get('shell') ? String(args.get('shell')).replace(/\/$/, '') : null;

function die(message) {
  console.error(`[extract-poster] ${message}`);
  process.exit(1);
}

// ---- BLAKE3 CAS identity (never sha256). The hasher lives in the runtime-kit
// slot-protocol-js wasm; it is supplied by arg/env so the DATA carries no path.
// If unreachable, poster_ref stays null and the engine's addressed_chunks output
// remains the authoritative CAS address for the same bytes.
async function loadHasher() {
  const candidate = args.get('hash-lib') ?? process.env.BITFIELD_SLOT_PROTOCOL_JS ?? null;
  if (!candidate) return null;
  try {
    const mod = await import(candidate);
    return typeof mod.makeHashCodeHexFromBytes === 'function' ? mod.makeHashCodeHexFromBytes : null;
  } catch {
    return null;
  }
}

async function casResolves(ref) {
  if (!SHELL || !ref) return false;
  try {
    const code = execFileSync('curl', ['-sS', '--max-time', '20', '--connect-timeout', '10',
      '-o', '/dev/null', '-w', '%{http_code}', `${SHELL}/cas/${encodeURIComponent(ref)}`], { encoding: 'utf8' }).trim();
    return code === '200';
  } catch {
    return false;
  }
}

// ---- idempotency: a poster_ref that already resolves in CAS means no work.
const EXISTING = args.get('existing-poster-ref') ?? null;
if (EXISTING && await casResolves(EXISTING)) {
  const out = { poster_ref: EXISTING, skipped: true, cas_durable: true, reason: 'existing poster_ref already resolves in CAS' };
  writeFileSync(RESULT, JSON.stringify(out));
  console.log(JSON.stringify(out));
  process.exit(0);
}

// ---- resolve the video to a local path (self-describing ref, L090).
function resolveVideo(ref) {
  if (/^1f:/.test(ref)) {
    if (!SHELL) die(`a 1f: CAS ref requires --shell to fetch: ${ref}`);
    const local = join(WORKDIR, 'source-input');
    const code = execFileSync('curl', ['-sS', '--max-time', '120', '--connect-timeout', '15',
      '-o', local, '-w', '%{http_code}', `${SHELL}/cas/${encodeURIComponent(ref)}`], { encoding: 'utf8' }).trim();
    if (code !== '200') die(`CAS fetch failed for ${ref} -> HTTP ${code}`);
    return local;
  }
  if (/^https?:\/\//.test(ref)) {
    const local = join(WORKDIR, 'source-input');
    const code = execFileSync('curl', ['-sSL', '--max-time', '120', '--connect-timeout', '15',
      '-o', local, '-w', '%{http_code}', ref], { encoding: 'utf8' }).trim();
    if (!/^2\d\d$/.test(code)) die(`video fetch failed for ${ref} -> HTTP ${code}`);
    return local;
  }
  if (!existsSync(ref)) die(`video file not found: ${ref}`);
  return ref;
}

const videoPath = resolveVideo(VIDEO);

// ---- probe duration and resolve the seek time.
function probeDuration(path) {
  try {
    const raw = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1', path], { encoding: 'utf8' }).trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
const duration = probeDuration(videoPath);

function resolveSeconds(at, dur) {
  const raw = at == null ? '0.25' : String(at);
  if (/s$/i.test(raw)) {
    const s = Number(raw.replace(/s$/i, ''));
    return Number.isFinite(s) ? Math.max(0, s) : 0;
  }
  const f = Number(raw);
  if (!Number.isFinite(f)) return 0;
  if (f > 1) return f; // a bare number greater than one is treated as absolute seconds
  const base = dur ?? 0;
  return Math.max(0, f * base);
}
let seekSeconds = resolveSeconds(args.get('at'), duration);
// clamp inside the clip so a fraction of a probed duration cannot land past the end.
if (duration && seekSeconds > duration - 0.05) seekSeconds = Math.max(0, duration - 0.05);

// ---- extract ONE frame. Seek before -i is deterministic keyframe-accurate seek;
// single thread + fixed qscale + fixed scale keep the encoded jpg byte-stable.
const vf = WIDTH && WIDTH > 0 ? ['-vf', `scale=${WIDTH}:-2`] : [];
try {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(seekSeconds), '-i', videoPath,
    '-frames:v', '1', '-threads', '1', ...vf, '-q:v', String(QUALITY), OUT], { encoding: 'utf8' });
} catch (error) {
  die(`ffmpeg failed: ${error.stderr?.toString().slice(-400) ?? error.message}`);
}

const jpg = readFileSync(OUT);
if (jpg.length < 3 || jpg[0] !== 0xff || jpg[1] !== 0xd8 || jpg[jpg.length - 2] !== 0xff || jpg[jpg.length - 1] !== 0xd9) {
  die(`extracted poster is not a valid JPEG (len ${jpg.length}, magic ${jpg.slice(0, 3).toString('hex')})`);
}

const makeHashCodeHexFromBytes = await loadHasher();
const poster_ref = makeHashCodeHexFromBytes ? makeHashCodeHexFromBytes(jpg) : null;

const out = {
  poster_ref,
  media_type: 'image/jpeg',
  byte_length: jpg.length,
  at_seconds: Number(seekSeconds.toFixed(3)),
  duration: duration ?? null,
  width: WIDTH && WIDTH > 0 ? WIDTH : null,
  poster_path: OUT,
  source_ref: /^(1f:|https?:\/\/)/.test(VIDEO) ? VIDEO : null,
  cas_durable: poster_ref ? await casResolves(poster_ref) : false,
  skipped: false,
};
writeFileSync(RESULT, JSON.stringify(out));
console.log(JSON.stringify(out));
