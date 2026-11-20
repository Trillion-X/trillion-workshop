// tools/audio-transcription/read-data/transcribe-a-file.mjs
//
// Purpose
//   tool:transcribe-file: the words said in one recording in the person's files, heard on this computer with the MLX
//   Whisper engine (do-work/transcribe_mlx.py, which shapes whisper_here.py's answer), answered with every word's own
//   start and end in seconds. It replaces the account-side tool:transcribe-file (records/workshop-account-tool-records.json,
//   which ran on every new audio file). It keeps nothing: tool:keep-transcript writes the answer through the record writer.
//
// Non-negotiable invariants
//   1. A word or segment without finite times is dropped, never given guessed times.
//   2. The person's file is never changed; hearARecording copies its bytes into a folder that is removed once heard.
//   3. The model is the one named here (MODEL_REPO), not an input: the answer says which engine heard it.
//   4. Refuses without `file`, in words; nothing is heard on a guess.

import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hearARecording } from './hear-here.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The Hugging Face repo the MLX engine reads from the local cache; it is not an input. */
export const MODEL_REPO = 'mlx-community/whisper-small-mlx';
/** The seam the MLX engine is called through (argv: transcribe --audio F --out F.json --model-path REPO). */
export const MLX_SCRIPT = path.join(HERE, '..', 'do-work', 'transcribe_mlx.py');
/** The Python with mlx_whisper. A computer run finds it on PATH or by the program the person granted. */
export const PYTHON = 'python3';

// Whisper's own control tokens ([_BEG_], <|en|>) are not words anyone said.
const SPECIAL = /^(\[_[^\]]*_\]|<\|.*\|>)$/;
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** The one shape a transcript is answered in, from the seam's answer (`heard`): text, timed segments with timed words, language. */
export function transcriptOfHeard(heard, { language = '', produced_by = 'mlx_whisper' } = {}) {
  const segments = (heard.segments ?? [])
    .filter(segment => finite(segment.start) && finite(segment.end))
    .map(segment => ({
      start: segment.start,
      end: segment.end,
      text: String(segment.text ?? '').trim(),
      words: (segment.words ?? [])
        .filter(word => finite(word.start) && finite(word.end))
        .map(word => ({ word: String(word.word ?? '').trim(), start: word.start, end: word.end }))
        .filter(word => word.word && !SPECIAL.test(word.word)),
    }));
  const text = String(heard.full_text ?? segments.map(segment => segment.text).join(' ')).trim();
  return { text, segments, language: heard.language || language || null, produced_by };
}

/** Hears one copied recording with the MLX seam; throws the seam's last line when it cannot hear it. */
async function hearWithMlx(file, { language = '', python = PYTHON } = {}) {
  const out = `${file}.heard.json`;
  try {
    await run(python, [MLX_SCRIPT, 'transcribe', '--audio', file, '--out', out, '--model-path', MODEL_REPO], { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new Error(String(error.stderr ?? '').trim().split('\n').pop() || error.message);
  }
  const heard = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });
  return transcriptOfHeard(heard, { language, produced_by: heard.engine ?? 'mlx_whisper' });
}

/**
 * tool:transcribe-file: { file, language? } -> { text, segments: [{ start, end, text, words }], language, heard_whole, produced_by }.
 * `file` is the recording's name or identity in the person's files, read by the run's host.
 */
export async function transcribeAFile(input, host, { hear = hearWithMlx } = {}) {
  if (!String(input?.file ?? '').trim()) {
    throw Object.assign(new Error('Give `file`: the recording\'s name or identity in the person\'s files.'), { status: 400 });
  }
  return hearARecording({ file: input.file, model_path: MODEL_REPO, language: input.language ?? '' }, host, {
    hear: (file, _hearing) => hear(file, { language: input.language ?? '' }),
  });
}
