// AI-edit endpoint for the editor preview: POST /api/ai-edit {instruction, cutList} ->
// a DATA-selected AI provider rewrites the cut list to satisfy the instruction, video-compose renders
// a new mp4, and the new cutList + reel URL come back so the timeline + player update.
// This is the you-plus-AI collaboration loop, standalone (the render authority is the real
// media-composition compositor; the "gateway" idea is the same: an external actor drives edits).
import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const VIDEO_COMPOSE = fileURLToPath(new URL('../do-work/video-compose.mjs', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

export function decodePreviewLibrary(value) {
  const rows = Array.isArray(value) ? value : value?.clips;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Preview library DATA must contain at least one clip.');
  const library = {};
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) throw new Error('Every preview clip needs a non-empty id.');
    if (typeof row.file !== 'string' || !row.file.trim()) throw new Error(`Preview clip ${row.id} needs an owner-resolved file locator.`);
    if (typeof row.label !== 'string' || !row.label.trim()) throw new Error(`Preview clip ${row.id} needs a label.`);
    if (!Number.isFinite(row.dur) || row.dur <= 0) throw new Error(`Preview clip ${row.id} needs a positive duration.`);
    if (library[row.id]) throw new Error(`Preview clip id ${row.id} is duplicated.`);
    library[row.id] = { file: row.file, label: row.label, dur: row.dur, thumb: typeof row.thumb === 'string' ? row.thumb : '' };
  }
  return library;
}

function decodeCommand(value, name) {
  const command = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || !part)) {
    throw new Error(`${name} must be a non-empty JSON argv array selected by provider DATA.`);
  }
  return command;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

// Ask the AI for a new cut list. Returns { cutList, summary }.
async function aiRecut(instruction, cutList, library, aiCommand) {
  const libLines = Object.entries(library).map(([id, v]) => `  "${id}": "${v.label}" (full length ${v.dur}s)`).join('\n');
  const prompt = [
    'You are a video editor. You edit a short vertical reel by choosing an ordered CUT LIST from a fixed clip library.',
    'Each cut is {"id": <library id>, "in": <start seconds into that clip>, "out": <end seconds>}. in < out, both within the clip full length.',
    '',
    'CLIP LIBRARY (only these ids exist):',
    libLines,
    '',
    `CURRENT CUT LIST:\n${JSON.stringify(cutList)}`,
    '',
    `THE USER WANTS: ${instruction}`,
    '',
    'Return ONLY a compact JSON object, no prose, no code fences:',
    '{"cutList":[{"id":"...","in":0.0,"out":0.0}, ...], "summary":"<one short sentence describing what you changed>"}',
  ].join('\n');

  const { stdout } = await execFileP(aiCommand[0], [...aiCommand.slice(1), prompt], { timeout: 120000, maxBuffer: 1024 * 1024 });
  const m = stdout.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`AI did not return JSON: ${stdout.slice(0, 200)}`);
  const parsed = JSON.parse(m[0]);
  const clean = (parsed.cutList || [])
    .filter((c) => library[c.id] && Number.isFinite(c.in) && Number.isFinite(c.out) && c.out > c.in)
    .map((c) => ({ id: c.id, in: Math.max(0, c.in), out: Math.min(library[c.id].dur, c.out) }));
  if (!clean.length) throw new Error('AI returned an empty or invalid cut list');
  return { cutList: clean, summary: String(parsed.summary || 'Recut the reel.') };
}

// Render an ordered list of segments (each {sourceId,in,out}) to a fresh mp4 in
// public/. The segments come from MATERIALIZING the current composition (the fold
// of the edit-decision stream), so the render is a pure function of the primitive's
// output. Returns the browser URL. This is the engine/ffmpeg half; the primitive
// (composeTimeline) runs client-side and is the SSOT for what to render.
// h264 requires even dimensions; clamp a requested size to a sane even value else fall back.
function even(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 16) return fallback;
  return Math.round(v / 2) * 2;
}
async function renderSegments(segments, textOverlays, transitions, stamp, dims, library, composeCommand) {
  const clean = (segments || [])
    .filter((s) => library[s.sourceId] && Number.isFinite(s.in) && Number.isFinite(s.out) && s.out > s.in);
  if (!clean.length) throw new Error('no renderable segments');
  // Text elements (first-class timeline overlays) are self-describing DATA — pass the
  // valid ones straight to edl.text_overlays; video-compose gates each by its time range.
  const overlays = (textOverlays || [])
    .filter((o) => o && typeof o.text === 'string' && o.text.trim() && Number.isFinite(o.start) && Number.isFinite(o.end) && o.end > o.start);
  const work = join(tmpdir(), `media-composition-preview-${stamp}`);
  mkdirSync(work, { recursive: true });
  // Per-clip transform (speed/volume/fade) rides the EDL segment; video-compose
  // buildClip honors segment.speed / .volume / .fade_in_s / .fade_out_s. Undefined
  // fields are omitted so absent = identity.
  const seg = (s, i) => {
    const o = { id: `s${i}`, kind: 'clip', source: library[s.sourceId].file, in: s.in, out: s.out };
    if (Number.isFinite(s.speed) && s.speed > 0 && s.speed !== 1) o.speed = s.speed;
    if (Number.isFinite(s.volume) && s.volume !== 1) o.volume = s.volume;
    if (Number.isFinite(s.fade_in_s) && s.fade_in_s > 0) o.fade_in_s = s.fade_in_s;
    if (Number.isFinite(s.fade_out_s) && s.fade_out_s > 0) o.fade_out_s = s.fade_out_s;
    // Burned caption: video-compose buildClip writes s.label.text to a textfile and
    // draws it on the normalized frame. Only pass a non-empty caption.
    if (s.label && typeof s.label.text === 'string' && s.label.text.trim()) o.label = s.label;
    return o;
  };
  const edl = {
    base: { kind: 'video', artifact: library[clean[0].sourceId].file },
    // Aspect ratio is DATA from the top-bar segmented control: it drives the render
    // dimensions (default 9:16 = 1080x1920). Even values only (h264 requires it).
    encode: { width: even(dims?.width, 1080), height: even(dims?.height, 1920), fps: 30, crf: 20, preset: 'veryfast', audio_bitrate: '128k' },
    spine: {
      segments: clean.map(seg),
      // Boundary transitions (transitions[i] between segment i and i+1). Pass valid
      // DATA rows straight to the universal transition primitive; null = hard cut.
      transitions: Array.isArray(transitions)
        ? transitions.map((t) => (t && typeof t.type === 'string' && t.type ? { renderer: t.renderer || 'xfade', type: t.type, duration: Number(t.duration) > 0 ? Number(t.duration) : 0.5 } : null))
        : [],
    },
    text_overlays: overlays.map((o) => ({ text: o.text, x: o.x, y: o.y, start: o.start, end: o.end, size: o.size, color: o.color })),
  };
  const edlPath = `${work}/edl.json`;
  writeFileSync(edlPath, JSON.stringify(edl));
  const out = `${PUBLIC_DIR}reel-${stamp}.mp4`;
  await execFileP(composeCommand[0], [...composeCommand.slice(1), VIDEO_COMPOSE, '--edl', edlPath, '--out', out, '--workdir', work], { timeout: 240000, maxBuffer: 1024 * 1024 });
  return `/reel-${stamp}.mp4`;
}

// Decode REAL audio peaks for a clip [in,out] of a source file via ffmpeg: extract
// mono 8kHz s16le PCM for the segment, downsample to `buckets` max-abs peaks, normalize
// to [0,1]. This is the server-side twin of do-work/decode-audio-peaks.ts (which is
// browser-only Web Audio) — the source clips are filesystem paths only ffmpeg reads, so
// extraction happens here. Reuses the ffmpeg engine; no new dependency.
async function peaksFor(file, inS, outS, probeCommand, buckets = 120) {
  const dur = Math.max(0.05, outS - inS);
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(inS), '-i', file, '-t', String(dur), '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'];
  const { stdout } = await execFileP(probeCommand[0], [...probeCommand.slice(1), ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  const n = pcm.length;
  if (n === 0) return [];
  const per = Math.max(1, Math.ceil(n / buckets));
  const raw = [];
  for (let b = 0; b < buckets; b += 1) {
    const start = b * per;
    const end = Math.min(start + per, n);
    let max = 0;
    for (let i = start; i < end; i += 1) { const a = Math.abs(pcm[i]); if (a > max) max = a; }
    raw.push(max);
  }
  const gmax = raw.reduce((m, v) => (v > m ? v : m), 0) || 1;
  return raw.map((v) => Number((v / gmax).toFixed(3)));
}

// The library as plain DATA rows the UI renders (id + label + full duration +
// thumbnail url). This is the "generic agnostic dumb blind" list: the panel walks
// these rows, it names no clip. Adding a clip = one more row here (or a real
// media-library record when this rides the live package), zero UI code change.
export function libraryRows(library) {
  return Object.entries(library).map(([id, v]) => ({ id, label: v.label, dur: v.dur, thumb: v.thumb || `/thumbs/${id}.jpg` }));
}

// Vite plugin: mounts POST /api/ai-edit + GET /api/library on the dev server.
export function aiEditPlugin(options = {}) {
  const library = decodePreviewLibrary(options.library ?? JSON.parse(process.env.MEDIA_COMPOSITION_PREVIEW_LIBRARY_JSON || 'null'));
  const aiCommand = decodeCommand(options.aiCommand ?? process.env.MEDIA_COMPOSITION_PREVIEW_AI_COMMAND_JSON, 'AI command');
  const composeCommand = decodeCommand(options.composeCommand ?? process.env.MEDIA_COMPOSITION_PREVIEW_COMPOSE_COMMAND_JSON, 'Compose command');
  const probeCommand = decodeCommand(options.probeCommand ?? process.env.MEDIA_COMPOSITION_PREVIEW_PROBE_COMMAND_JSON, 'Probe command');
  return {
    name: 'ai-edit-endpoint',
    configureServer(server) {
      server.middlewares.use('/api/library', (req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ clips: libraryRows(library) }));
      });
      // AI authoring (the ai-fix modality stand-in): natural language + the current
      // clip list -> the AI's TARGET clip list. The client turns each target clip
      // into an `add-source` decision the primitive folds; it does NOT render here.
      server.middlewares.use('/api/ai-edit', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
        try {
          const { instruction, cutList } = await readBody(req);
          if (!instruction || !Array.isArray(cutList)) return send(400, { error: 'need {instruction, cutList}' });
          const recut = await aiRecut(instruction, cutList, library, aiCommand);
          return send(200, { cutList: recut.cutList, summary: recut.summary });
        } catch (e) {
          return send(500, { error: String(e && e.message ? e.message : e).slice(0, 400) });
        }
      });

      // Render the materialized composition: POST {segments:[{sourceId,in,out}]} (the
      // fold output of the edit-decision stream) -> a fresh mp4 -> {reelUrl}. This is
      // the only server-side/ffmpeg step; the primitive stays client-side + pure.
      let renderSeq = 0;
      server.middlewares.use('/api/render', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
        try {
          const { segments, text_overlays, transitions, width, height } = await readBody(req);
          if (!Array.isArray(segments)) return send(400, { error: 'need {segments:[{sourceId,in,out}]}' });
          const stamp = `${Date.now()}-${renderSeq++}`;
          const reelUrl = await renderSegments(segments, text_overlays, transitions, stamp, { width, height }, library, composeCommand);
          return send(200, { reelUrl });
        } catch (e) {
          return send(500, { error: String(e && e.message ? e.message : e).slice(0, 400) });
        }
      });

      // Real audio peaks per clip: POST {clips:[{key,sourceId,in,out}]} -> {peaks:{key:number[]}}.
      // Each key gets the true audio envelope of that source segment (via ffmpeg), so the
      // A1 waveform shows real audio instead of a synthetic one.
      server.middlewares.use('/api/peaks', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
        try {
          const { clips } = await readBody(req);
          if (!Array.isArray(clips)) return send(400, { error: 'need {clips:[{key,sourceId,in,out}]}' });
          const peaks = {};
          for (const c of clips) {
            const lib = library[c.sourceId];
            if (!lib || !Number.isFinite(c.in) || !Number.isFinite(c.out) || c.out <= c.in) continue;
            try { peaks[c.key] = await peaksFor(lib.file, c.in, c.out, probeCommand, 120); } catch { peaks[c.key] = []; }
          }
          return send(200, { peaks });
        } catch (e) {
          return send(500, { error: String(e && e.message ? e.message : e).slice(0, 400) });
        }
      });
    },
  };
}