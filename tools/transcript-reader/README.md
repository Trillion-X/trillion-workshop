# parts/transcript-reader

The shared reader for what is said in a recording: timed passages with each word at its own second, searchable, following playback, and choosable to jump to a moment.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The part's public modules. |
| `read-data/read-transcript-records.ts` | Transcript types and reading: `TranscriptSegment`/`TranscriptWord` shapes, reading published transcript records into entries and segments, and ranking search matches (words found plus meaning-search order). |
| `read-data/edit-transcript.ts` | Pure edits to a recording's kept passages: `nameSpeaker`, `takeNameBack`, `namedSpeakers`, `splitPassage` (before a chosen word), `transcriptAsText`, `clock`. Tested by `test/transcript-note-tools.test.mjs`. |
| `show/transcript-tools.json`, `show/transcript-languages.json` | The words the note tools say, and the languages "Reprocess in" offers (one row each). |
| `show/TranscriptReaderSurface.tsx` | The reader: a search box, an optional speaker filter, timestamp seek controls, the word being said highlighted during playback, and a choice of passage or word handed back to the caller. With `tools` it adds the note tools: click a speaker to rename them (searchable list headed "Speakers in this recording", add a name, or take the name back), copy a link to a passage's moment, a Split pill (Enter) before the last chosen word, and a menu with Copy transcript, Export PDF and Reprocess in (searchable languages). |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `TranscriptSegment` | `{ id, transcript_ref, text, start_ms?, end_ms?, words?, speaker?, confidence?, ... }` | One passage, times in milliseconds. |
| `TranscriptWord` | `{ word, start, end, confidence?, loudness? }` | One word, times in seconds. |
| `TranscriptEntry` | `{ id, label?, media_ref?, content_ref? }` | Which recording a transcript belongs to. |
| `TranscriptData` | `{ entries, segments }` | What `readTranscriptData` returns. |
| `readTranscriptData(source)` | `unknown -> TranscriptData` | Reads published transcript records. |
| `readTranscriptSegments(...)` | segments for one transcript | Reads one transcript's passages. |
| `rankTranscriptSearchResults(segments, query, semanticMatches?)` | `-> TranscriptSegment[]` | Word matches and meaning-search matches in one order. |
| `transcriptSpeakers(segments)` | `-> string[]` | Distinct named speakers in first-seen order. |
| `transcriptSegmentsForSpeaker(segments, speaker)` | `-> TranscriptSegment[]` | All passages or only those assigned to the selected speaker. |
| `TranscriptReaderSurface(props)` | `{ segments, entry?, title?, currentTimeSeconds?, semanticMatches?, onSearchQueryChange?, onSelectSegment?, onSelectTime?, selectedRange?, onSelectRange? }` | The reader component. With `onSelectRange`, clicking a word chooses it and shift-clicking another extends the choice to it; the chosen stretch (`selectedRange`, seconds in the recording) is shown chosen (`aria-pressed`). |

## Dependencies

**Depends on:** `parts/screen-ready-records` (reading published records), React, `lucide-react`.
**Depended on by:** `src/workspace/media-edit/transcribe-panel.tsx` (the editor's Words panel), `src/workspace/note-transcript.tsx` (a recording's note).
