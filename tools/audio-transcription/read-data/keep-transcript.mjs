// tools/audio-transcription/read-data/keep-transcript.mjs
//
// Purpose
//   Keeps one transcript that tool:transcribe-file answered. The old account-action kept it beside the recording as its
//   `transcript` result (src/account-transcription.mjs); this step names the answer as one keep row for the export runner
//   (records-door/do-work/run-an-export.mjs, --keep-into file_transcripts), which writes it through the connection mounted
//   on the row when the run's input names a `database`. The function writes nothing itself.
//
// Non-negotiable invariants
//   1. The keep row's id is the recording's identity (1f:<64 hex>), so one recording keeps one transcript.
//   2. `expected` is null: a new transcript is written only where none is kept yet. A repeat is answered by the caller
//      from the kept row, never kept twice.
//   3. A transcript that is not there, or a recording without an identity, is refused in words.

const IDENTITY = /^1f:[0-9a-f]{64}$/;

/** The keep list for one transcript: `{ keep: [{ id, type, value, expected }] }`. */
export function keepTranscript(input = {}) {
  const transcript = input.transcript;
  if (typeof input.identity !== 'string' || !IDENTITY.test(input.identity)) {
    throw Object.assign(new Error('Give `identity`: the recording\'s identity (1f: and 64 hex characters), as tool:transcribe-file was given it.'), { status: 400 });
  }
  if (!transcript || typeof transcript !== 'object' || !Array.isArray(transcript.segments)) {
    throw Object.assign(new Error('Give `transcript`: the answer tool:transcribe-file gave, with its segments.'), { status: 400 });
  }
  return { keep: [{ id: input.identity, type: 'transcript', value: { identity: input.identity, ...transcript }, expected: null }] };
}
