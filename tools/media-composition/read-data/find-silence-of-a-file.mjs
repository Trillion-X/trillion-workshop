// tools/media-composition/read-data/find-silence-of-a-file.mjs
//
// Purpose
//   tool:find-silence as a function of its input: the video the person names by its identity is handed to detect-silence
//   as a file (files-identity-as-a-file.mjs), and the answer is the same object the CLI prints (do-work/detect-silence.mjs):
//   the silent intervals, the keep stretches, the duration and the settings used.
//   Run by workflows do-work/run-a-function.mjs as findSilenceOfAFile(input, host).
//
// Non-Negotiable Invariants
//   1. The video is read through the run's host only; this file names no path of the person's.
//   2. The answer's fields are the CLI's fields, so a caller of the container form gets the same answer.
import { detectSilence, keepSpansFromSilences } from '../do-work/detect-silence.mjs';
import { withFilesIdentityAsFile } from './files-identity-as-a-file.mjs';

export async function findSilenceOfAFile(input, host) {
  return withFilesIdentityAsFile(host, input.video, file => {
    const found = detectSilence(file, { thresholdDb: input.threshold_db, minSilenceSec: input.min_silence_seconds });
    const { silences, duration, thresholdDb, minSilenceSec } = found;
    const keep = keepSpansFromSilences(silences, duration, { pad: input.pad_seconds });
    return { silences, keep, duration, threshold_db: thresholdDb, min_silence: minSilenceSec, pad: input.pad_seconds ?? 0.05, count: keep.length };
  });
}
