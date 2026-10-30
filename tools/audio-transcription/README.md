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
| `do-work/audio_transcription.py` | The seam: `transcribe` (runs the package's script and adds the recording's length), `find-loops` and `repair`. |
| `read-data/whisper_loops.py` | Pure: what a loop is, the windows to hear again, moving a heard window into place, and the splice. |
| `tool-rows.json` | The row `tool:transcribe-audio-and-repair-whisper-loops`: `on-your-computer`. |
| `part.json` | Nothing here is imported by other code. |
| `test/audio-transcription-seam.test.mjs` | Runs the seam on a tone made with ffmpeg and a stand-in `whisper-cli` that loops the way Whisper does. |
| `test/test_whisper_loops.py`, `test/fake_whisper_cli.py` | The pure readers, and the stand-in recognizer. |

## How to run it

```
brew install whisper-cpp ffmpeg
python3 do-work/audio_transcription.py transcribe --audio ./take.wav --out ./take.json --model-path ./ggml-tiny.en.bin
python3 do-work/audio_transcription.py find-loops --transcript ./take.json
python3 do-work/audio_transcription.py repair --transcript ./take.json --audio ./take.wav --model-path ./ggml-tiny.en.bin
```

Options: `--whisper-cli PATH`, `--ffmpeg PATH`, `--out FILE` (for `repair`; default is in place). The model file is the person's own choice; a larger one hears better.

## Loops

- A segment is a loop when one sentence fills at least half of it and is said at least four times, or when it says exactly what the segment before it said.
- Loop segments less than 15 seconds apart join into one window, padded 4 seconds each side and kept inside the recording. A window is heard again when it holds four or more loop segments or lasts 8 seconds or more.
- Each window is cut from the recording and heard again with whisper.cpp's context off (`-mc 0`). The package's own `normalize_whisper_json` reads the answer, so the words carry the same `timing_source`. A segment that still loops is left out, with its words. Any loop that survives elsewhere is removed and kept in `removed_hallucinated`. `repaired_windows` records the windows, and a transcript that has it is not repaired twice. Segments are numbered again and `full_text` is made again.

## Not ported

- `built-stored-bytes/` and `.bitfield-entry-scope/`: the package's build outputs.
- The package's `compute.process` wiring: the Workshop row runs the same script directly on the person's computer instead of inside the package's contained runtime.

## Dependencies

**Depends on:** Python 3.10 or later, ffmpeg and ffprobe, `whisper-cli` (whisper.cpp) and a ggml model file. The package's own tests need Node.

**Depended on by:** `tool-rows.json` (`tool:transcribe-audio-and-repair-whisper-loops`).
