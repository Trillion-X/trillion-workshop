#!/usr/bin/env node
/**
 * file: packages/media-composition/do-work/batch-produce-reels.mjs
 *
 * PURPOSE: The batch reel-production orchestrator. Turns a DATA list of real
 * source clips into a batch of edited, looked, poster'd reels by COMPOSING the
 * existing capability (video-compose.mjs is the render authority, extract-poster.mjs
 * is the poster). It owns NO rendering, NO look math, NO poster logic; it is a blind
 * loop that authors one comp per clip and shells the render/poster executables.
 * This is the "fill the library at volume" engine: `count` and `looks` are DATA
 * knobs, so 5 or 5000 reels is the same code path (L149 acquisition-engine: the
 * autonomous workers pull real footage and edit it at volume).
 *
 * A "reel" is a single-clip comp: {base, tracks, spine:{segments:[{source,in,out,
 * look_stack}]}, encode}. video-compose consumes this comp directly as --edl
 * (proven 2026-08-10). The look_stack value is a DATA key into LOOK_STACKS
 * (vhs / crt / dreamy-bloom / cinematic-bloom, extensible by a DATA row), so
 * this file never names an effect.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. ZERO effect/look vocabulary; looks are DATA keys cycled from --looks.
 * 2. Composes existing executables only (video-compose.mjs, extract-poster.mjs);
 *    never re-implements render or poster extraction.
 * 3. The input clip list is DATA (a TSV of casPath, origName, size or a JSON
 *    array); dropping a totally different footage set works with zero code change.
 * 4. Failures name the clip and stage; a failed clip is skipped, the batch continues.
 *
 * Usage:
 *   node batch-produce-reels.mjs \
 *     --manifest <tsv: casPath TAB origName TAB size> \
 *     --count 12 \
 *     --looks vhs,crt,dreamy-bloom,cinematic-bloom \
 *     --out-dir <dir> \
 *     --width 540 --height 960 --fps 24 --seconds 5 \
 *     --poster-width 480 --poster-at 0.4 \
 *     --result <batch.json>
 *
 * Output (--result): a JSON array of reel descriptors:
 *   [{ id, title, look, source, video_path, poster_path, poster_data_uri, video_multihash }]
 * The caller writes these as media-composition.render-manifest records (inline or
 * log-published) so they appear in the Video Library gallery.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorReelPlan, applyPlanToEdl } from './author-reel-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIDEO_COMPOSE = join(HERE, 'video-compose.mjs');
const EXTRACT_POSTER = join(HERE, 'extract-poster.mjs');

function parseArgs(argv) {
  const a = new Map();
  for (let i = 2; i < argv.length; i += 2) a.set(argv[i].replace(/^--/, ''), argv[i + 1]);
  return a;
}

// Humanize a source filename into a reel title. Content-addressed CAS names
// (bare hex) fall back to a numbered reel; descriptive export names are cleaned
// (drop leading numeric prefixes, underscores to spaces, titlecase).
function deriveTitle(origPath, index) {
  const raw = basename(origPath || '').replace(/\.[a-z0-9]+$/i, '');
  let name = raw
    .replace(/^[0-9]+[_-]+/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || /^[0-9a-f]{16,}$/i.test(name)) name = `Reel ${String(index + 1).padStart(2, '0')}`;
  name = name.replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
  if (name.length > 60) name = name.slice(0, 57) + '...';
  return name;
}

function loadClips(manifestPath) {
  const txt = readFileSync(manifestPath, 'utf8');
  if (manifestPath.endsWith('.json')) {
    const arr = JSON.parse(txt);
    return arr.map((r) => (typeof r === 'string' ? { source: r, orig: r } : { source: r.source || r.cas, orig: r.orig || r.name || r.source }));
  }
  return txt
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [cas, orig] = l.split('\t');
      return { source: cas, orig: orig || cas };
    });
}

function main() {
  const args = parseArgs(process.argv);
  const manifest = args.get('manifest');
  const count = Number.parseInt(args.get('count') || '12', 10);
  const looks = (args.get('looks') || 'vhs,crt,dreamy-bloom,cinematic-bloom').split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = args.get('out-dir') || '/tmp/reel-batch';
  const W = Number.parseInt(args.get('width') || '540', 10);
  const H = Number.parseInt(args.get('height') || '960', 10);
  const FPS = Number.parseInt(args.get('fps') || '24', 10);
  const SECONDS = Number.parseFloat(args.get('seconds') || '5');
  const posterWidth = Number.parseInt(args.get('poster-width') || '480', 10);
  const posterAt = Number.parseFloat(args.get('poster-at') || '0.4');
  const resultPath = args.get('result') || join(outDir, 'batch.json');
  // Opt-in INTELLIGENT batch: run the authorReelPlan capstone per clip so each reel is action-trimmed,
  // vertically reframed, publish-loudness-normalized, and poster'd at the best frame (vs the dumb fixed window).
  // `--plan 1` turns it on; the dumb fixed-window path is unchanged when off. Composition only (L069): the plan
  // is DATA applied to the same comp the render already consumes; batch owns no intelligence itself.
  const usePlan = ['1', 'true', 'yes'].includes(String(args.get('plan') || '').toLowerCase());
  const skipUnusable = ['1', 'true', 'yes'].includes(String(args.get('skip-unusable') || '').toLowerCase());

  if (!manifest) throw new Error('--manifest <tsv|json> is required');
  if (!existsSync(VIDEO_COMPOSE)) throw new Error(`video-compose.mjs not found at ${VIDEO_COMPOSE}`);
  if (!existsSync(EXTRACT_POSTER)) throw new Error(`extract-poster.mjs not found at ${EXTRACT_POSTER}`);
  mkdirSync(outDir, { recursive: true });

  const clips = loadClips(manifest).filter((c) => c.source).slice(0, count);
  const out = [];
  let i = 0;
  for (const clip of clips) {
    const idx = String(i + 1).padStart(2, '0');
    const id = `reel-b${idx}`;
    const look = looks[i % looks.length];
    const title = deriveTitle(clip.orig, i);
    const compPath = join(outDir, `${id}.comp.json`);
    const videoPath = join(outDir, `${id}.mp4`);
    const posterPath = join(outDir, `${id}.jpg`);
    const posterResult = join(outDir, `${id}.poster.json`);
    let comp = {
      base: { kind: 'color', color: 'black' },
      tracks: [{ id: 'video' }],
      spine: { segments: [{ id: `clip:${id}:video:base`, kind: 'clip', source: clip.source, track_id: 'video', in: 0, out: SECONDS, look_stack: look }] },
      encode: { width: W, height: H, fps: FPS, deterministic: true },
    };
    let posterAtEff = posterAt;
    // Intelligent path: the capstone decides trim/reframe/loudness/poster; apply it onto the same comp (DATA).
    if (usePlan) {
      const plan = authorReelPlan(clip.source, { width: W, height: H, minQualityScore: skipUnusable ? undefined : 0, lines: clip.lines });
      if (skipUnusable && plan.usable === false) { console.error(`[batch] ${idx} SKIP (unusable: quality ${plan.quality.score.toFixed(2)})  clip=${basename(clip.source)}`); i += 1; continue; }
      comp = applyPlanToEdl(comp, plan);
      // The plan's best-poster time is in the SOURCE timeline; the reel is trimmed to the action window, so map
      // it into the trimmed reel's local time (subtract the action start) and clamp so it never seeks past EOF.
      if (Number.isFinite(plan.poster_time)) {
        posterAtEff = Math.max(0, plan.poster_time - (plan.action ? plan.action.start : 0));
      }
    }
    writeFileSync(compPath, JSON.stringify(comp));
    try {
      const renderOut = execFileSync('node', [VIDEO_COMPOSE, '--edl', compPath, '--out', videoPath], { encoding: 'utf8' });
      let video_multihash = null;
      try { video_multihash = JSON.parse(renderOut.trim().split('\n').pop()).video_multihash ?? null; } catch {}
      execFileSync('node', [EXTRACT_POSTER, '--video', videoPath, '--at', String(posterAtEff), '--width', String(posterWidth), '--out', posterPath, '--result', posterResult], { encoding: 'utf8' });
      const posterBytes = readFileSync(posterPath);
      const poster_data_uri = `data:image/jpeg;base64,${posterBytes.toString('base64')}`;
      out.push({ id, title, look, source: clip.source, video_path: videoPath, poster_path: posterPath, poster_data_uri, video_multihash });
      console.log(`[batch] ${idx}/${clips.length} OK  look=${look}  ${title}`);
    } catch (e) {
      console.error(`[batch] ${idx} SKIP (${String(e).split('\n')[0]})  clip=${basename(clip.source)}`);
    }
    i += 1;
  }
  writeFileSync(resultPath, JSON.stringify(out, null, 2));
  console.log(`[batch] wrote ${out.length}/${clips.length} reels -> ${resultPath}`);
}

main();
