// tools/media-composition/do-work/tts-narrate.mjs
/**
 * #99 TTS narration PRODUCER. Generates a real narration audio file from text, selecting the speech
 * engine by DATA (L069 producer map, exactly like #90 TRANSLATION_PRODUCERS). It is a PRODUCER: it
 * WRITES an audio artifact; the caller adds that artifact as an audio-lane source (add-source), and
 * the compositor mixes it blind as an `audio_graph.narration` entry. A new engine (piper, coqui,
 * elevenlabs, azure) is ONE more row here, zero engine changes. Voice + engine are DATA, never code.
 *
 * Usage: node tts-narrate.mjs <text> <out.wav> [producer=macos-say] [voice]
 * Output (stdout, JSON): { out, producer, voice, duration }
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const ffmpegBin = process.env.MEDIA_FFMPEG_BIN ?? 'ffmpeg';
const ffprobeBin = process.env.MEDIA_FFPROBE_BIN ?? 'ffprobe';

/** Each producer takes (text, outWav, cfg) and writes a 48k stereo wav at outWav. cfg carries the
 *  optional voice + an explicit bin path (env-overridable so no machine path lives in source). */
const TTS_PRODUCERS = {
  // macOS built-in `say`: renders to aiff, then ffmpeg normalizes to 48k stereo wav.
  'macos-say': (text, outWav, cfg) => {
    const aiff = `${outWav}.aiff`;
    const args = [];
    if (cfg?.voice) args.push('-v', cfg.voice);
    args.push('-o', aiff, text);
    const r = spawnSync(cfg?.bin ?? process.env.MEDIA_SAY_BIN ?? 'say', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`say failed: ${r.stderr ?? r.error ?? ''}`);
    const c = spawnSync(ffmpegBin, ['-y', '-i', aiff, '-ar', '48000', '-ac', '2', outWav], { encoding: 'utf8' });
    if (existsSync(aiff)) rmSync(aiff);
    if (c.status !== 0) throw new Error(`aiff->wav failed: ${c.stderr ?? ''}`);
    return outWav;
  },
  // espeak-ng writes wav directly; -a resamples to 48k stereo through ffmpeg for a consistent bus.
  'espeak-ng': (text, outWav, cfg) => {
    const raw = `${outWav}.raw.wav`;
    const r = spawnSync(cfg?.bin ?? process.env.MEDIA_ESPEAK_BIN ?? 'espeak-ng', ['-v', cfg?.voice ?? 'en', '-w', raw, text], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`espeak-ng failed: ${r.stderr ?? r.error ?? ''}`);
    const c = spawnSync(ffmpegBin, ['-y', '-i', raw, '-ar', '48000', '-ac', '2', outWav], { encoding: 'utf8' });
    if (existsSync(raw)) rmSync(raw);
    if (c.status !== 0) throw new Error(`espeak wav resample failed: ${c.stderr ?? ''}`);
    return outWav;
  },
};

const text = process.argv[2];
const outWav = process.argv[3];
const producer = process.argv[4] || 'macos-say';
const voice = process.argv[5] || undefined;
if (!text || !outWav) {
  process.stderr.write('[tts-narrate] usage: node tts-narrate.mjs <text> <out.wav> [producer] [voice]\n');
  process.exit(2);
}
const run = TTS_PRODUCERS[producer];
if (!run) {
  process.stderr.write(`[tts-narrate] unknown producer "${producer}" (have: ${Object.keys(TTS_PRODUCERS).join(', ')})\n`);
  process.exit(2);
}

run(text, outWav, { voice });
const probe = spawnSync(ffprobeBin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outWav], { encoding: 'utf8' });
const duration = Number((probe.stdout ?? '').trim());
process.stdout.write(`${JSON.stringify({ out: outWav, producer, voice: voice ?? null, duration: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null })}\n`);
