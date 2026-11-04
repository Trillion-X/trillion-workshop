// src/voice-memos.mjs
//
// PURPOSE
//   tool:keep-a-voice-memo (records/workshop-voice-and-formats-tool-records.json): any recording already in the
//   person's files becomes a voice memo the same way one made on the Record screen does (src/workspace/recording.mjs):
//   its words kept beside it as "<name> transcript.txt" (the script first, when it was read from one), and the
//   recording handed to the person's AIs as the Record screen's own job row of src/queued-work.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The words are the ones given, or the file's own transcript (tool:transcribe-file); nothing is made up, and a
//      length is never guessed: without a transcript's timing, the caller says how many seconds it runs.
//   2. The transcript's name, its text and the job are the Record screen's (recording.mjs), so a memo kept by an AI
//      and one kept on the screen are the same thing.
//   3. Keeping the same recording again hands it on once (the press key is the recording's identity).
//   4. A recording that came with a message (src/inbound.mjs invariant 6) is handed on as part of that message's item,
//      so the memo and its words are one job, never two.
//
// deps: { open(identity) -> { name, media_type }, transcribe(identity) -> { text, segments }, keep({ name, size, open,
//         media_type }) -> { identity, name }, formats() -> [format], queue(press, { item }) -> { asked_id, repeated, said },
//         itemOf(identity) -> the message the file came with, or null }

import { recordingJob, scriptFor, transcriptFileText, transcriptNameBeside } from './workspace/recording.mjs';

const text = value => (typeof value === 'string' ? value.trim() : '');
const lastEnd = segments => (Array.isArray(segments) ? segments.reduce((end, segment) => Math.max(end, Number(segment?.end) || 0), 0) : 0);

export async function keepVoiceMemo(input, deps) {
  const identity = text(input.identity);
  if (!/^1f:[0-9a-f]{64}$/.test(identity)) throw new Error('Name the recording by its identity in your files (find_file or list_files give it).');
  const audio = await deps.open(identity);
  if (!/^\s*(audio|video)\//i.test(audio.media_type ?? '')) throw new Error(`${audio.name} is not a recording: a voice memo is made from an audio or video file.`);
  let script = null;
  if (text(input.format_id)) {
    const format = deps.formats().find(row => row.id === text(input.format_id));
    if (!format) throw new Error(`There is no format "${text(input.format_id)}": read content_formats for their ids.`);
    script = scriptFor(format, text(input.about));
  }
  const given = typeof input.words === 'string';
  const heard = given ? { text: input.words, segments: [] } : await deps.transcribe(identity);
  const bytes = new TextEncoder().encode(transcriptFileText(heard.text ?? '', script));
  const keepTranscript = () => deps.keep({ name: transcriptNameBeside(audio.name), size: bytes.byteLength, open: async () => [bytes], media_type: 'text/plain; charset=utf-8' });
  // Silence says nothing about what a video shows. Keep silent audio without asking an AI to act on it, but hand
  // silent footage on for visual inspection under the same recording key. Its job does not invent a duration or words.
  if (!given && !(heard.text ?? '').trim()) {
    const kept = await keepTranscript();
    const result = { audio_file: audio.name, transcript_file: kept.name, transcript_identity: kept.identity, words: '', nothing_said: true };
    if (!/^\s*video\//i.test(audio.media_type)) return result;
    const asked = await deps.queue({ job_id: 'hand-silent-video', context: {
      audio_file: audio.name, audio_identity: identity, transcript_file: kept.name,
    }, press_key: `voice-memo:${identity}` }, { item: deps.itemOf(identity) });
    return { ...result, asked_id: asked.asked_id, repeated: asked.repeated, said: asked.said };
  }
  const seconds = Number.isFinite(input.seconds) && input.seconds > 0 ? input.seconds : lastEnd(heard.segments);
  if (!(seconds > 0)) throw new Error('Say how many seconds the recording runs, as seconds, when you give its words.');
  const kept = await keepTranscript();
  const job = recordingJob({ audioFile: audio.name, transcriptFile: kept.name, seconds, script });
  // A recording that came with a message is part of that message: its job joins the message's one job.
  const asked = await deps.queue({ ...job, press_key: `voice-memo:${identity}` }, { item: deps.itemOf(identity) });
  return { audio_file: audio.name, transcript_file: kept.name, transcript_identity: kept.identity, words: heard.text ?? '', asked_id: asked.asked_id, repeated: asked.repeated, said: asked.said };
}
