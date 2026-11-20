// tools/audio-transcription/read-data/hear-with-programs.mjs
//
// Purpose
//   Hears one recording with the two programs a record-and-hear grant allows (ffmpeg and whisper-cli) and no Python, so the
//   hearing runs inside a computer sandbox that grants no interpreter. ffmpeg makes a 16 kHz mono WAV; whisper-cli hears it
//   with -ng (no GPU): the Metal back end compiles its shaders through xcrun, which that sandbox blocks. The arguments are the
//   ones do-work/audio_transcription.py passes to the package script, so the words match what that path gives.
//
// Non-negotiable invariants
//   1. Only the two programs named here run; no interpreter, no shell.
//   2. The work folder is made for each recording and removed after, whatever happens; the recording itself is never written.
//   3. A program that fails says why in plain words: the last line of its error, never an empty answer.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const seconds = ms => (Number.isFinite(ms) ? ms / 1000 : 0);

const failure = (what, error) => new Error(String(error.stderr ?? '').trim().split('\n').pop() || `${what} failed: ${error.message}`);

// The rows of whisper's JSON that are words: empty rows and special tokens are dropped, the two shapes transcribe-audio.py:133 skips
// ([_...] and <|...|>); punctuation such as "-" is kept, as the old path kept it.
const SPECIAL = /^(\[_[^\]]*_\]|<\|.*\|>)$/;
export function wordRows(heard) {
  const rows = Array.isArray(heard.transcription) ? heard.transcription : Array.isArray(heard.segments) ? heard.segments : [];
  return rows
    .map(item => ({ start: seconds(item.offsets?.from), end: seconds(item.offsets?.to), text: String(item.text ?? '').trim() }))
    .filter(segment => segment.text && !SPECIAL.test(segment.text));
}

/**
 * { text, segments: [{ start, end, text }], language, produced_by } for one recording, heard by `whisperCli` with `modelPath`
 * after `ffmpeg` makes its WAV. `env` is the environment the programs run in (default: this process's).
 */
export async function hearWithPrograms(file, { modelPath, whisperCli, ffmpeg = 'ffmpeg', env = process.env, produced_by = 'whisper-cli on this computer' }) {
  if (!String(modelPath ?? '').trim()) throw new Error('Give the Whisper model file.');
  if (!String(whisperCli ?? '').trim()) throw new Error('Give the whisper-cli program.');
  const work = mkdtempSync(path.join(os.tmpdir(), 'hear-with-programs-'));
  try {
    const wav = path.join(work, 'normalized.wav');
    await run(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], { env, maxBuffer: 64 * 1024 * 1024 })
      .catch(error => { throw failure('ffmpeg', error); });
    const base = path.join(work, 'heard');
    await run(whisperCli, ['-m', modelPath, '-f', wav, '-oj', '-ojf', '-ml', '1', '-sow', '-of', base, '-np', '-ng'], { env, maxBuffer: 64 * 1024 * 1024 })
      .catch(error => { throw failure('whisper-cli', error); });
    const heard = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
    const segments = wordRows(heard);
    return { text: segments.map(segment => segment.text).join(' ').trim(), segments, language: heard.result?.language || null, produced_by };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
