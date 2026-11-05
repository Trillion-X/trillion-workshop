# tools/audio-transcription/

The audio-transcription package's local Whisper transcription with word times, as a Workshop tool, plus finding where Whisper looped and hearing only those windows again. The package's own files are copied unchanged, tests included. The new code is only the Workshop seam: the command, the loop finder, the tool row and their tests.

## Files

| File | Purpose |
|------|---------|
| `do-work/process-scripts/transcribe-audio.py` | The package's transcriber, unchanged: decodes any recording to 16 kHz mono, runs whisper.cpp, and answers language, full text, segments and words with a `timing_source` (`engine_token_timestamps`, `segment_bounds_fallback` or `segment_uniform_estimate`). |
| `do-work/process-scripts/make-audio-transcription-records-from-command-output.py` | The package's record maker, unchanged. |
| `do-work/audio-master.mjs`, `do-work/submit-audio-transcription.ts`, `do-work/prepare-local-whisper-admission.py`, `do-work/README.md` | The rest of the package's `do-work`, unchanged. |
| `do-work/__tests__/` | The package's 39 tests, unchanged. |
| `runtime/local-whisper/` | The package's contained runtime contract and image recipe, unchanged. |
| `show/`, `things-to-store-and-run.json`, `entry-to-package-data-map.json` | The package's screen, its data and its entry map, unchanged; the package's tests read them. |
| `do-work/audio_transcription.py` | The seam: `transcribe` (runs the package's script and adds the recording's length, path and when it was made), `transcribe-many`, `find-loops`, `repair`, `repair-many`, `judge`, `index` and `text`. |
| `do-work/read_transcript_files.py` | `read-file` and `read-files`: a transcript file (srt, vtt, `## h:mm:ss.fff - h:mm:ss.fff` txt, `hh:mm:ss:ff` timecode txt at `--fps`, or a recognizer's json) into a words.json with `timing` word, segment or none; `read-files` reads every file of a list from a folder of their bytes. Moved from source-repo-a (`ports/read-transcript-files.json`). |
| `do-work/pick_transcript_files.py` | The transcript-like files of one root in an asset index, each joined to the person's file store by sha256 (the files door's answer as `--held` JSON, or a namespace sqlite copy read only); writes the list `read-files` takes. Moved from source-repo-a (`ports/pick-transcript-files.json`). |
| `do-work/caption_transcripts.py` | A channel download's YouTube json3 captions (`raw/json3`, `raw/meta`, `raw/flat-videos.jsonl`) into `transcripts/<id>.txt` paragraphs and `index.tsv`; the channel's label is an argument. Moved from source-repo-a (`ports/caption-transcripts.json`). |
| `do-work/find_whisper_quotes.py` | Each quote of `quote-check.tsv` cited from a whisper transcript, found by its exact words among `raw/whisper/<id>.json`'s word times and checked against its window (`--window-seconds`, 45). Moved from source-repo-a (`ports/find-whisper-quotes.json`). |
| `do-work/show_segments.py` | The segments of one words.json between two seconds. Moved from source-repo-a (`ports/show-segments.json`). |
| `ports/` | The port contract of each file moved from source-repo-a: its source, the byte-copy commit and what changed. |
| `read-data/transcript_reports.py` | Pure: when a recording was made (camera sidecar XML or file time), the index line and totals, the judge of a whole answer, and timed paragraphs. |
| `do-work/whisper_here.py` | Speech to text with word times on whichever Whisper engine the place has: a drop-in for `mlx_whisper.transcribe(path, path_or_hf_repo=..., **options)` answering mlx_whisper's shape from mlx-whisper, faster-whisper or openai-whisper (below). Moved from source-repo-a `tools/place-capabilities/whisper_here.py`@5a9ba39 (`ports/whisper-here.json`). |
| `do-work/word_onsets.py` | `tool:move-word-starts-to-where-the-voice-starts`: a voice take's Whisper word starts moved to the first 10 ms above a silence line (default -45 dBFS), ends kept; with the take's line file, the script's spelling when the word counts agree (a hyphen split joined). One JSON request on stdin. Moved from a film's `narrator/tools/word_onsets.py`. |
| `test/test_word_onsets.py`, `test/word-onsets.test.mjs` | A made-up tone take with a start inside the pause, the silence line, the script spelling, a hyphen split, a count mismatch and the refusals. Needs numpy and soundfile. |
| `read-data/whisper_loops.py` | Pure: what a loop is, the windows to hear again, moving a heard window into place, and the splice. |
| `read-data/hear-here.mjs` | `hearARecording` (`tool:hear-a-recording`) and `hearALink` (`tool:hear-a-link`), run as functions by `tools/records-door`: a recording read through the run's door, or a link's captions or sound, heard with `transcribe` on the person's computer; a heard link's sound is kept in their files with its words beside it. Moved from the product repo's `computer/listen.mjs` (`listeningTools.transcribe`) and `computer/hear-a-link.mjs`. |
| `read-data/hear-a-link.json` | The link readers (the yt-dlp row: `info`, `captions`, `sound`, `search_path`, `update_hint`), the caption languages, where a heard sound is kept, the longest fetch and every word the AI reads. |
| `tool-rows.json` | `tool:hear-a-recording` and `tool:hear-a-link`: `computer` rows with `start-a-program` (the person grants the `record-and-hear` programs: ffmpeg, whisper-cli and the models folder); and `tool:transcribe-audio-and-repair-whisper-loops`: `on-your-computer`. |
| `src/account-transcription.mjs` | `tool:transcribe-file` on the account side, moved byte for byte from Trillion-X/trillion (`moved-from.json`): hears one audio or video file in the person's Trillion files (a video through its sound alone), long files in pieces, and keeps the transcript with every word's own seconds beside the file; a kept transcript with word timings is reused. Its meeting hearing options come from `tools/record-voice-and-meetings/read-data/meeting-settings.mjs`. |
| `src/transcript-words.mjs` | The one shape a transcript is kept in (`text`, `segments` with `words`, `language`); a word or segment without finite times is dropped, never given guessed ones. |
| `moved-from.json` | Each moved file's source path, commit and identities. |
| `part.json` | Public: `src/account-transcription.mjs` and `src/transcript-words.mjs`, which trillion-apps imports (the meeting settings and transcript tests of its screens), and `do-work/whisper_here.py`, which film scripts moved from source-repo-a import in place of `mlx_whisper`. |
| `test/audio-transcription-seam.test.mjs` | Runs the seam on a tone made with ffmpeg and a stand-in `whisper-cli` that loops the way Whisper does. |
| `test/test_whisper_loops.py`, `test/test_transcript_reports.py`, `test/fake_whisper_cli.py` | The pure readers, and the stand-in recognizer. |
| `test/test_whisper_here.py`, `test/whisper-here.test.mjs` | The engine chooser with every engine a stand-in module: the order and `WHISPER_BACKEND`, the model names, each engine's options and answer, and that no Python here imports `mlx_whisper` but the chooser. The `.mjs` runs it in `npm test`. |
| `ports/whisper-here.json` | The port contract of `do-work/whisper_here.py` (`ports/feature-files.json`). |
| `test/test_transcript_files.py`, `test/transcript-files.test.mjs` | The five moved readers and `judge --durations` / `text --header`, run as commands on made-up files. |
| `test/test_probe_duration.py` | A recording's length read from the granted ffmpeg when ffprobe cannot start. |
| `test/hear-a-recording.test.mjs` | A recording read through a fake door, heard in the run's folder and removed; the seam's answer; a heard sound kept in pieces with its words. |
| `test/hear-a-link.test.mjs` | Captions win, no captions is heard, and every road with no words says why (the product repo's `test/hear-a-link.test.mjs`, its assertions kept). |
| `test/hear-in-pieces.test.mjs` | A long recording heard in pieces: each piece's words keep their seconds from the start of the whole file (moved with `src/account-transcription.mjs`). |

## How to run it

```
brew install whisper-cpp ffmpeg
python3 do-work/audio_transcription.py transcribe --audio ./take.wav --out ./take.json --model-path ./ggml-tiny.en.bin
python3 do-work/audio_transcription.py find-loops --transcript ./take.json
python3 do-work/audio_transcription.py repair --transcript ./take.json --audio ./take.wav --model-path ./ggml-tiny.en.bin

python3 do-work/audio_transcription.py transcribe-many --recordings ./card --pattern '*.MP4' --out-dir ./transcripts --workers 3 --max-load 80 --model-path ./ggml-tiny.en.bin
python3 do-work/audio_transcription.py repair-many --transcript ./transcripts/*.json --workers 2 --model-path ./ggml-tiny.en.bin
python3 do-work/audio_transcription.py index --transcripts ./transcripts
python3 do-work/audio_transcription.py judge --transcript ./transcripts/*.json
python3 do-work/audio_transcription.py text --transcript ./transcripts/C0001.json --out ./C0001.txt
python3 do-work/audio_transcription.py judge --transcript ./raw/whisper/*.json --durations ./index.tsv --duration-column duration_s
python3 do-work/audio_transcription.py text --transcript ./raw/whisper/v1.json --out ./v1.txt --title 'A title' --header 'https://example.com/v1' --duration 300

python3 do-work/read_transcript_files.py read-file --file ./talk.srt --out ./talk.words.json
python3 do-work/pick_transcript_files.py --assets ./assets.jsonl --root my-drive --held ./held.json --out ./list.tsv
python3 do-work/read_transcript_files.py read-files --list ./list.tsv --bytes ./bytes --out-dir ./words --root my-drive --origin my-store
python3 do-work/caption_transcripts.py --corpus ./channel --channel 'Channel label'
python3 do-work/find_whisper_quotes.py --corpus ./channel
python3 do-work/show_segments.py ./words/clip.words.json 0 60
```

Options: `--whisper-cli PATH`, `--ffmpeg PATH`, `--out FILE` (for `repair`; default is in place). The model file is the person's own choice; a larger one hears better.

## Whisper on whatever engine the place has

`do-work/whisper_here.py` is for Python that hears with Whisper itself rather than through whisper.cpp. Call `whisper_here.transcribe(audio, path_or_hf_repo="mlx-community/whisper-large-v3-turbo", word_timestamps=True, ...)` where you would call `mlx_whisper.transcribe`.

- `WHISPER_BACKEND=mlx|faster|openai` picks the engine; any other value is refused with the three names. Otherwise the first that imports runs, in this order: `mlx` (mlx-whisper, Apple silicon only), `faster` (faster-whisper: CTranslate2 on cuda or cpu, the same weights converted), `openai` (openai-whisper: torch on cuda, mps or cpu). A place with none is told to install one.
- The model is named the mlx way and mapped for the others: `mlx-community/whisper-large-v3-turbo` is `large-v3-turbo`, `mlx-community/whisper-small-mlx` is `small`.
- `verbose` is dropped. mlx-whisper gets every other option; the others get only `language`, `word_timestamps`, `condition_on_previous_text`, `initial_prompt`, `temperature`, `no_speech_threshold` and `compression_ratio_threshold`. faster-whisper runs on `WHISPER_DEVICE` (default `auto`), and its segments carry `words` only when `word_timestamps` was asked.
- `result["engine"]` says which engine made the answer (`mlx_whisper`, `faster-whisper` or `openai-whisper`): word times from another engine are close to mlx-whisper's but not the same bytes.

## Loops

- A segment is a loop when one sentence fills at least half of it and is said at least four times, or when it says exactly what the segment before it said.
- Loop segments less than 15 seconds apart join into one window, padded 4 seconds each side and kept inside the recording. A window is heard again when it holds four or more loop segments or lasts 8 seconds or more.
- Each window is cut from the recording and heard again with whisper.cpp's context off (`-mc 0`). The package's own `normalize_whisper_json` reads the answer, so the words carry the same `timing_source`. A segment that still loops is left out, with its words. Any loop that survives elsewhere is removed and kept in `removed_hallucinated`. `repaired_windows` records the windows, and a transcript that has it is not repaired twice. Segments are numbered again and `full_text` is made again.

## Many recordings, and what to trust

- `transcribe-many` writes `<name>.json` for every file in `--recordings` that matches `--pattern`, skips one already written, hears `--workers` at once and waits while the 1-minute load average is above `--max-load`. Every transcript also carries `source` (the recording's path), `recorded_at` and `recorded_at_from`: the `CreationDate` of a camera's sidecar XML beside the recording (`<stem>M01.XML` or `<stem>.XML`), else the file's modified time.
- `repair-many` repairs each transcript from the recording its `source` names; one without a `source` is refused by name.
- `index` writes `index.tsv` (name, duration, words, segments, first line) and prints recordings, hours, silent ones, segments and words.
- `judge` rejects a whole answer when one segment's text is a quarter or more of all segments and said three or more times, one run of four words comes back at least max(6, half the minutes) times, under 18% of more than 40 words are different words, there are under 30 words a minute, or more than half the segments carry a no-speech probability over 0.6 (when the recognizer gives one). It names each reason.
- `judge` and `text` take the recording's length as `--duration` when the transcript does not carry it (a recognizer's raw answer); `judge --durations LIST.tsv` reads each one's from a list (`--id-column`, default `id`, matched to the transcript's file name up to its first dot; `--duration-column`, default `duration`).
- `text` writes `# title`, the source, a blank line, then `[m:ss] paragraph` lines (`--header LINE`, repeated, replaces the source and transcript lines), a new paragraph at the first segment 30 seconds (`--paragraph-seconds`) after the last began. It refuses a transcript `judge` rejects, unless `--even-if-rejected`.

## Not yet

- `tool:hear-a-link` cannot run on the engine yet. Its link reader is a program no capability starts: `start-a-program` holds `record-and-hear` (ffmpeg, whisper-cli), and a run may also start only `/bin` and `/usr/bin`. It needs a program row in trillion-rust `src/runtime/workshop/computer-capabilities.json` `programs` such as `{"id": "read-a-link", "parameters": {"program": "program"}, "sandbox": ["(allow process-exec* file-read* (literal \"{program}\"))", "(allow network-outbound (remote tcp \"*:443\") (remote tcp \"*:80\"))", "(allow mach-lookup (global-name \"com.apple.dnssd.service\"))"]}`, and it needs record-and-hear in the same run for a page with no captions, which one `program_by` capability cannot give (computer.rs:139 counts one program-picking capability per row). The engine's computer runs have no network rule at all (`base`), so the fetch is refused today.
- The programs are passed as input (`whisper_cli`, `ffmpeg`, `link_reader`) as well as granted: `tools/records-door/do-work/run-an-export.mjs` hands the function only `input`, and the grant's paths reach a run only through argv fills of `grants.start-a-program.*` (computer.rs:244).
- `python3` is `/usr/bin/python3`; on a Mac without the Command Line Tools' Python under `/usr/bin` the seam cannot start, and the shim's real program under `/Library/Developer/CommandLineTools` is outside the base sandbox's reads. Unproved on a Mac.

## Not ported

- `built-stored-bytes/` and `.bitfield-entry-scope/`: the package's build outputs.
- The package's `compute.process` wiring: the Workshop row runs the same script directly on the person's computer instead of inside the package's contained runtime.

## Dependencies

**Depends on:** `tools/records-door` (`read-data/whole-file.mjs`, `do-work/run-an-export.mjs`) for the computer rows; Python 3.10 or later, ffmpeg (ffprobe when it can start), `whisper-cli` (whisper.cpp) and a ggml model file. `do-work/whisper_here.py` needs one of mlx-whisper, faster-whisper or openai-whisper, installed by the caller; its tests need none. The package's own tests need Node.

**Depended on by:** `tool-rows.json` (`tool:hear-a-recording`, `tool:hear-a-link`, `tool:transcribe-audio-and-repair-whisper-loops`, `tool:read-transcript-files-and-captions-into-timed-words`); `tools/listen-for-a-while` runs `do-work/audio_transcription.py transcribe` on each piece.
