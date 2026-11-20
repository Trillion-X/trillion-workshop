// tools/audio-transcription/read-data/extract-audio.mjs
//
// Purpose
//   The audio-only step of the transcription pipeline, for recordings too big to hear whole (tool:transcribe-file takes at most
//   512 MB). It reads the sound track alone from a recording (a local path or a share URL, which ffmpeg reads by byte ranges)
//   and writes 16 kHz mono WAV, the input the MLX Whisper seam takes. It is not a row: nothing wires it yet.
//
// Non-negotiable invariants
//   1. Only the audio is written (-vn); the video is never decoded or kept.
//   2. The output is 16 kHz mono PCM WAV, the same shape transcribe_mlx.py hears.
//   3. The source is never changed; the caller removes the output once heard.
//   4. Refuses an empty source or output in words, and a window that is not a positive number of seconds.

/** The ffmpeg argv that extracts the audio of `source` into `output`, optionally from `start` for `seconds` long. */
export function extractAudioArgv({ source, output, start = 0, seconds = null, ffmpeg = 'ffmpeg' } = {}) {
  if (!String(source ?? '').trim()) throw Object.assign(new Error('Give `source`: the recording (a local path or a share URL).'), { status: 400 });
  if (!String(output ?? '').trim()) throw Object.assign(new Error('Give `output`: the WAV file to write.'), { status: 400 });
  if (!Number.isFinite(start) || start < 0) throw Object.assign(new Error('Give `start` as seconds from the start, 0 or more.'), { status: 400 });
  if (seconds !== null && (!Number.isFinite(seconds) || seconds <= 0)) throw Object.assign(new Error('Give `seconds` as a positive number, or leave it out for the whole recording.'), { status: 400 });
  return [
    ffmpeg, '-v', 'error', '-y',
    ...(start > 0 ? ['-ss', String(start)] : []),
    '-i', source,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    ...(seconds !== null ? ['-t', String(seconds)] : []),
    '-f', 'wav', output,
  ];
}
