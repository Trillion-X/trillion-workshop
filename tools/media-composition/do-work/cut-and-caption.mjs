#!/usr/bin/env node
/**
 * file: packages/media-composition/do-work/cut-and-caption.mjs
 *
 * PURPOSE: Cut one stretch out of a video and burn in its spoken words as captions in a chosen caption style. It
 * only ASSEMBLES existing owners: the transcript's words become caption lines (read-data/caption-lines.ts, gathered
 * as the style says), the lines become a subtitle in the style (read-data/caption-styles.mjs over the catalog
 * read-data/caption-styles.json), and the cut plus subtitle become one edit that video-compose.mjs renders. It owns no
 * ffmpeg filter and no caption look.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. The video is any address ffmpeg can open (a web address or a file path); nothing here reads a machine path.
 * 2. Caption times are relative to the cut: a word spoken at 12.4 s in a cut starting at 10 s shows at 2.4 s.
 * 3. A transcript is read by shape, never by who made it: `{ words }`, `{ segments: [{ words }] }` or a bare
 *    word list, each word `{ text | word, start, end }`. No transcript means no captions, never a guess.
 * 4. Failures name what was wrong (the times, the transcript) and exit non-zero.
 *
 * Usage: node cut-and-caption.mjs --video <address> [--from <seconds>] [--to <seconds>] --output <file.mp4>
 *          [--transcript <json>] [--transcript-from <seconds>] [--style <style id | json style row>]
 * `--transcript-from` is where in the video the transcript's zero is: 0 for a transcript of the whole video, the
 * cut's start for a transcript of the cut's own audio.
 * Without --from and --to the whole video is kept (captioning a finished clip).
 * Prints the measured render (render-an-edit.mjs) with the expected length and the caption count on its last line.
 */
import { execFileSync } from 'node:child_process';
import { captionLinesForCut, wordsOf } from '../read-data/caption-lines.ts';
import { captionAss, resolveCaptionStyle } from '../read-data/caption-styles.mjs';
import { renderEdl } from './render-an-edit.mjs';

/** The caption style the command names: a style id from read-data/caption-styles.json, a style row of one's own as
 *  JSON (starting from a catalog style named by its `id`), or nothing for the default style. */
export function styleFromArgument(text) {
  const given = typeof text === 'string' ? text.trim() : '';
  if (!given) return resolveCaptionStyle(undefined);
  if (!given.startsWith('{')) return resolveCaptionStyle(given);
  let parsed;
  try { parsed = JSON.parse(given); } catch { throw new Error('The caption style is neither a style name nor JSON.'); }
  return resolveCaptionStyle(parsed);
}

/** The one edit: a single cut of the video, with the captions burned in when there are lines to show. */
export function cutCaptionEdl({ video, from, to, lines = [], style, width, height }) {
  if (typeof video !== 'string' || !video) throw new Error('A video address is needed.');
  if (!(Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from)) throw new Error(`The cut must start at 0 or later and end after it starts; it was ${from} to ${to}.`);
  // The output keeps the video's own frame size; without it the render would use its default canvas and stretch
  // anything that is not that shape (a vertical clip, a square one).
  const edl = { ...(width > 0 && height > 0 ? { encode: { width, height } } : {}), spine: { segments: [{ kind: 'clip', id: 'cut', source: video, in: from, out: to }] } };
  const ass = lines.length ? captionAss(lines, style, { width, height }) : undefined;
  if (ass) edl.subtitles = { ass };
  return edl;
}

function probeVideo(video) {
  const probed = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', video], { encoding: 'utf8' }));
  const { width, height } = probed.streams?.[0] ?? {};
  const duration = Number(probed.format?.duration);
  if (!(width > 0 && height > 0 && duration > 0)) throw new Error('The video has no picture and length ffprobe can read.');
  return { width, height, duration };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    const video = args.get('video');
    const output = args.get('output');
    if (!output) throw new Error('An --output file is needed.');
    let transcript = null;
    if (args.get('transcript')) {
      try { transcript = JSON.parse(args.get('transcript')); } catch { throw new Error('The transcript is not JSON.'); }
    }
    const style = styleFromArgument(args.get('style'));
    const { width, height, duration } = probeVideo(video);
    // Without --from and --to the whole video is kept, so the same script captions a finished clip.
    const from = args.has('from') && args.get('from') !== '' ? Number(args.get('from')) : 0;
    const to = args.has('to') && args.get('to') !== '' ? Math.min(Number(args.get('to')), duration) : duration;
    const transcriptFrom = Number(args.get('transcript-from') ?? 0);
    if (!Number.isFinite(transcriptFrom)) throw new Error('--transcript-from must be a number of seconds.');
    const lines = transcript ? captionLinesForCut(wordsOf(transcript), from, to, style.grouping, transcriptFrom) : [];
    const edl = cutCaptionEdl({ video, from, to, lines, style, width, height });
    process.stdout.write(`${JSON.stringify({ expected_duration_seconds: Math.round((to - from) * 1000) / 1000, ...renderEdl(edl, output), captions: lines.length })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
