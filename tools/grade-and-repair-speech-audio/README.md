# grade-and-repair-speech-audio

Scripts a person's AI runs by hand on the person's own computer. For each stretch of speech in a set of recordings they decide: keep the sound as it is when it is good; remaster it when noise, hum, wind, room echo, clipping or loudness spoil it; and, when the remaster is still bad, say the same words again in the speaker's own voice. Every result is read back with a speech transcriber. Nothing in the source recordings is changed.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | Four Workshop rows, all `on-your-computer`: `tool:grade-and-repair-speech-audio`, `tool:clone-speech-that-repair-could-not-fix`, `tool:read-back-repaired-speech`, `tool:pick-the-cleanest-speech-to-clone-from`. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/grade_and_repair_speech.py` | `grade` measures every span; `all` also remasters the failing ones and grades them again. Writes `grades.json`, `audio/` and `work/`. |
| `do-work/clone_speech.py` | Re-voices spans still graded `clone`, in the reference voice, phrase by phrase, after the speaker check. |
| `do-work/check_speech_by_reading.py` | Reads every audio file back with whisper and counts word errors. |
| `do-work/choose_clone_reference.py` | Ranks the cleanest ten-second windows of continuous speech in the person's own recordings. |
| `do-work/reading.py` | Whisper reads and the word-error count, shared by the three stages that read. |
| `do-work/speaker_check.py` | Cosine similarity of wespeaker embeddings; the guard that stops a clone of anyone but the reference speaker. |
| `do-work/dfn_batch.py` | Runs DeepFilterNet3 (full, and limited to the settings' soft limit) inside the python that has it installed. |
| `read-data/measure.py` | Loudness, noise floor from the pauses between words, SNR, clipping, mains hum, wind rumble, room tail of one span. |
| `read-data/grade_rules.py` | Turns one measurement into good, remaster or clone with reasons, against the person's settings. |
| `read-data/settings.py`, `read-data/settings-keys.json` | The person's settings: every key with its meaning and type, and the loader that stops a run naming any key that is missing or of the wrong type. The tool ships no values. |
| `read-data/gap_duck.py` | Lowers the pauses by 14 dB when the room was the fault. |
| `read-data/phrases.py` | Splits a span's words into phrases at the pauses of the original. |
| `read-data/spans.py` | Reads the spans file; the span id; the graded file's name. |
| `test/` | Synthetic speech (a voiced tone at known word times over a noise floor), the checks of the pure readers, and the grading stage run for real. |

## Spans file

A JSON object with a `spans` list. Each span has `clip` (a name for the recording), `source` (its media file), `from` and `to`, `text` (the words said) and, optionally, `words` (a list of `text`, `start` and `end`).

`from`, `to` and the word times are seconds in the source. `words` is optional: without it the noise floor is the quietest fifth of the span, no room tail is measured, the pauses cannot be ducked and the span cannot be cloned. The span id is `clip_from_to`; a cut listed twice is graded once.

## How to run it

```
python3 -m pip install -U numpy scipy soundfile mlx-whisper
python3 -m venv deepfilternet-venv && deepfilternet-venv/bin/python -m pip install deepfilternet soundfile
python3 do-work/grade_and_repair_speech.py all --spans spans.json --settings settings.json --out ./graded --deepfilternet-python deepfilternet-venv/bin/python
python3 do-work/choose_clone_reference.py --recordings recordings.json --settings settings.json --out ./reference
python3 do-work/clone_speech.py --spans spans.json --settings settings.json --out ./graded --reference reference-file --reference-text text-said-in-it
python3 do-work/check_speech_by_reading.py --settings settings.json --out ./graded
```

It needs ffmpeg, and an Apple Silicon Mac (mlx). Use a python that has mlx-whisper (and, for cloning, mlx-audio, librosa, torch and pyannote.audio); DeepFilterNet goes in its own venv because its torch pins clash. Without `--deepfilternet-python` the remaster tries ffmpeg afftdn only.

Models, named so nothing is fetched unseen, each downloaded on first run: the settings' `read_model` (a speech-to-text model mlx-whisper loads), `DeepFilterNet3` (comes with the deepfilternet package, MIT or Apache-2.0), the settings' `clone_model` (a voice-cloning model mlx-audio loads), `pyannote/wespeaker-voxceleb-resnet34-LM` (CC-BY-4.0, may need a Hugging Face login). Reads are in the settings' language.

## Output

`grades.json`: per span `grade` good|remaster|clone, `treatment` as-is|remastered|needs-clone, `reasons`, `raw` and `remastered` measures, `remaster_choice`, `remaster_candidates` (SNR and word errors of each), `cloned` true|false, `not_cloned` when a clone was refused, and `audio` (`audio/<span id>.wav`, mono 48 kHz 24-bit, the settings' handle before `from` and after `to`). A span with `cloned: true` must be shown as cloned wherever it is used. `work/state.json` holds what the later stages read.

## Grade, remaster, clone

- **Grade.** Thresholds are the person's settings. Hum, wind and room tail count only when the noise is high enough to matter; low SNR, room tail and clipping are hard faults a remaster is not trusted to fix.
- **Remaster.** High-pass, a notch at the hum and its harmonics, then DeepFilterNet3 full, DeepFilterNet3 limited to the settings' soft limit and ffmpeg afftdn. Each gets the same finish (duck the pauses when the room was the fault, de-ess, gentle compression, the settings' loudness target) and a whisper read. The candidate whose read matches the original read or the text, with the best SNR, wins. DeepFilterNet can eat words when noise overlaps the voice, so the winner is chosen by read, not by SNR.
- **Clone.** Only the voice of the reference, which must be a recording of the person who agreed to be cloned. A span whose speaker similarity to the reference is under the settings' `speaker_similarity_min` is refused and keeps its best remaster. Each phrase is spoken by the clone model, read by whisper (zero word errors), stretched to the time the original phrase took (at most `clone_phrase_stretch_max`) and laid at its original offset.
- **Read back.** Zero word errors against the read of the untouched cut or against the text passes a kept or remastered span; zero against the text passes a cloned one. Two reads of nearly the same audio differ by a filler word now and then; the check lists them.

## Settings

The tool is mechanism only and carries no values of its own. Every number that depends on a person's microphone, room, loudness target or voice is read at run time from one JSON file the person gives (`--settings`), either written from their own records (through the records door) or kept at a path they name. `read-data/settings-keys.json` lists each key with its meaning and type: what counts as too noisy, hummy, windy, echoey, clipped, quiet or loud; the remaster's high-pass, notch, denoise limits, de-esser, compressor and loudness target; how far a cloned phrase may be stretched; how alike a voice must be to the reference; the window of loudness a clone reference may have; the language and the spoken forms a read may spell differently. A run with a key missing or of the wrong type stops and names it. `grades.json` records the settings it was made with, so a grade can always be explained.

The spans file, the recordings file, the reference recording and the settings are all the person's own data, passed in by path. Nothing of anyone's recordings, grades or settings is kept in this folder; the tests use generated audio and a settings file made up for it.

## Owner of the records side

The speech-request and voice-profile records, the records side of voice cloning and re-voicing, belong to `bitfield-packages/packages/speech-generation`. This folder is the audio mechanism only (grade, remaster, clone one span, read back), so cloning and re-voicing are not built twice: a voice profile or speech request is kept there, and the settings, the reference and the spans are passed in here by path.
