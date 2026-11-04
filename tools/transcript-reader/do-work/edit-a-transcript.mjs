// tools/transcript-reader/do-work/edit-a-transcript.mjs
//
// The edits a person makes to a recording's kept words in the transcript reader, run in order over the passages handed
// in: name a speaker (or take the name back) and split a passage before a chosen word, then the passages written as
// plain words for Copy and Export PDF. Every edit is read-data/edit-transcript.ts's own (nameSpeaker, takeNameBack,
// splitPassage, namedSpeakers, transcriptAsText); nothing is read, saved, played or sent.
//
// Input:  { passages: [{ start, end, text, speaker?, speaker_was?, words?: [{ word, start, end }] }],
//           edits?: [ { op: "name_speaker", from, name } | { op: "take_name_back", name } | { op: "split", passage, word } ] }
//         Times are seconds in the recording. `passage` is the place of a passage in the list as it is after the edits
//         before it; `word` the place of the word it is split before (not the first one).
// Answer: { passages, speakers, named_speakers, text }: the edited passages, the speakers in the order they first speak,
//         the ones the person named (each has a label to go back to), and the transcript as plain words.
// Refuses no passages, a passage without a start, end and text, an edit it does not know, and whatever the edit itself
// refuses (an empty name, a split at the first word or past the last).
import { namedSpeakers, nameSpeaker, splitPassage, takeNameBack, transcriptAsText } from '../read-data/edit-transcript.ts';

const EDITS = {
  name_speaker: (passages, { from, name }) => {
    if (typeof from !== 'string' || typeof name !== 'string') throw new Error('A name_speaker edit needs from (the label said now) and name (the name to say instead).');
    return nameSpeaker(passages, from, name);
  },
  take_name_back: (passages, { name }) => {
    if (typeof name !== 'string') throw new Error('A take_name_back edit needs name: the name to take back.');
    return takeNameBack(passages, name);
  },
  split: (passages, { passage, word }) => splitPassage(passages, passage, word),
};

export function editATranscript({ passages, edits = [] } = {}) {
  if (!Array.isArray(passages) || passages.length === 0) throw new Error('Give passages: a list of { start, end, text, speaker?, words? }, times in seconds.');
  passages.forEach((passage, index) => {
    if (!passage || !Number.isFinite(passage.start) || !Number.isFinite(passage.end) || typeof passage.text !== 'string') {
      throw new Error(`Passage ${index} needs start and end (seconds) and text.`);
    }
  });
  if (!Array.isArray(edits)) throw new Error('Give edits as a list, or leave them out.');
  let edited = passages;
  edits.forEach((edit, index) => {
    const run = EDITS[edit?.op];
    if (!run) throw new Error(`Edit ${index} has op ${JSON.stringify(edit?.op)}; choose one of: ${Object.keys(EDITS).join(', ')}.`);
    edited = run(edited, edit);
  });
  const speakers = [...new Set(edited.map(passage => passage.speaker?.trim()).filter(Boolean))];
  return { passages: edited, speakers, named_speakers: namedSpeakers(edited), text: transcriptAsText(edited) };
}
