/**
 * file: tools/media-composition/do-work/grade-a-video.mjs
 *
 * PURPOSE: Change a video's colour: put named looks on it (read-data/looks.json), adjust brightness, contrast,
 * saturation, exposure, warmth and vibrance, and/or match its colour to another video. It only composes owners:
 * read-data/looks.mjs turns the choices into render fields, one clip segment carries them, and render-an-edit.mjs
 * renders it with video-compose.mjs.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. The whole video is kept at its own size and length; only its colour changes. Its length is returned beside
 *    the measured one.
 * 2. Looks and adjustments are the DATA rows' ids and bounded numbers; an unknown look or an out-of-range number is
 *    refused with the choices that exist. Nothing typed here becomes a filter.
 * 3. Any address ffmpeg opens works for --video and --match-to; nothing here reads a machine path of its own.
 *
 * Usage: node grade-a-video.mjs --video VIDEO --output FILE [--looks "id,id" or a JSON list] [--brightness N] [--contrast N]
 *          [--saturation N] [--exposure N] [--warmth N] [--vibrance N] [--match-to VIDEO] [--match-at SECONDS]
 * Output (stdout, JSON): { expected_duration_seconds, duration_seconds, width, height, has_audio, bytes, segments, looks }
 */
import { execFileSync } from 'node:child_process';
import { LOOKS, chooseLooks, clipColourFields } from '../read-data/looks.mjs';
import { renderEdl } from './render-an-edit.mjs';

/** The clip's colour choices from command-line values (an empty value means "not given"). */
export function colourChoice(args) {
  const given = name => (args.get(name) ?? '') !== '';
  const number = name => {
    const value = Number(args.get(name));
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`);
    return value;
  };
  // A Workshop run hands a list input over as JSON; a person at a terminal may type ids separated by commas.
  const written = String(args.get('looks') ?? '').trim();
  const looks = !written ? [] : written.startsWith('[') ? JSON.parse(written) : written.split(',').map(id => id.trim()).filter(Boolean);
  const adjust = Object.fromEntries(LOOKS.adjustments.filter(row => given(row.id)).map(row => [row.id, number(row.id)]));
  const match = given('match-to') ? { reference: args.get('match-to'), ...(given('match-at') ? { at: number('match-at') } : {}) } : undefined;
  if (!looks.length && !Object.keys(adjust).length && !match) throw new Error(`Choose a look, an adjustment or a video to match. Looks: ${LOOKS.looks.map(look => look.id).join(', ')}.`);
  return { looks, adjust, match };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    const video = args.get('video');
    const output = args.get('output');
    if (!video || !output) throw new Error('usage: grade-a-video.mjs --video VIDEO --output FILE [--looks "id,id"] [--brightness N] [--contrast N] [--saturation N] [--exposure N] [--warmth N] [--vibrance N] [--match-to VIDEO] [--match-at SECONDS]');
    const probed = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', video], { encoding: 'utf8' }));
    const duration = Number(probed.format?.duration);
    if (!(duration > 0)) throw new Error('The video has no length ffprobe can read.');
    const choice = colourChoice(args);
    const edl = { spine: { segments: [{ kind: 'clip', id: 'graded', source: video, ...clipColourFields(choice) }] } };
    process.stdout.write(`${JSON.stringify({ expected_duration_seconds: Math.round(duration * 1000) / 1000, ...renderEdl(edl, output), looks: chooseLooks(choice.looks).map(look => look.id) })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
