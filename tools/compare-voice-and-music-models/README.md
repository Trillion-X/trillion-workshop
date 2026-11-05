# compare-voice-and-music-models

Scripts a person's AI runs on the person's own computer to try a candidate voice or music model before adopting it. Nothing here picks a model: each script makes or measures audio so the person can compare.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | Seven Workshop rows, all `on-your-computer`: `tool:say-lines-in-a-candidate-voice-model`, `tool:score-how-alike-lines-sound-to-a-reference-voice`, `tool:render-music-note-events-to-a-test-wav`, and for one narration line `tool:say-a-narration-line-in-a-kokoro-voice`, `tool:say-a-narration-line-in-a-cloned-voice-model`, `tool:measure-narration-takes`, `tool:make-and-measure-every-voice-take-of-a-line`. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/say_lines.py` | Evaluation only: says lines in a voice-cloning model mlx-audio loads (Apple silicon), cloned from a reference recording; one WAV per line. |
| `do-work/speaker_similarity.py` | Scores each line in one or more folders against the reference recording with the WeSpeaker ResNet34 speaker model (cosine of voice embeddings). |
| `do-work/render_note_events.py` | Test-only: renders a music transcription's JSON note events to a plain 48 kHz stereo WAV for an audio meter to measure. |
| `do-work/say_a_line_in_kokoro.py` | One narration line in a Kokoro voice: a generation per unit, misaki pronunciation markup, inner silences capped, set pauses between units. Also the one shared definition of the line, silences, settings (`DEFAULTS` under the person's settings row), the speech-to-text engine and refusals; `--take-rows` and `--chain` print the settings' takes and commands for `render_takes.sh`. |
| `do-work/say_a_line_in_a_cloned_voice.py` | One narration line in a voice-cloning model (Qwen3-TTS, Chatterbox Turbo, Pocket TTS or one the settings add), best of N per unit by whisper word errors, then length nearest the median. |
| `do-work/measure_takes.py` | The measures of each take: pauses with their words, pace and articulation rate, F0 range, a vowel's onset F2, words heard and word errors, same voice (WeSpeaker cosine) and accent probability. |
| `do-work/render_takes.sh` | Every A/B take of one line, one at a time, through the same clean and master commands, then the ticks command and the measure (bash, macOS's 3.2 too). |
| `test/fixtures/` | A made-up narration line and a made-up settings row. |
| `test/test_voice_ab.py` | The narration scripts with stand-in models and code-made audio: units, silences, best of N, pauses, rates, word errors, the settings read through a stand-in of the settings reader's command, and every refusal. |
| `test/stand-in-settings-reader.mjs` | The settings reader's command shape (`settings-of --record FILE --folder F`), for the tests. |
| `test/test_compare_models.py` | Runs `render_note_events.py` for real on made-up events, and tests the argument checks, pure parts and refusals of the other two (their model runs are not tested). |
| `test/compare-models.test.mjs` | Checks the rows and runs the Python tests. |

Each script prints a last line `{"result": ...}` or `{"error": ...}`.

## How to run it

Compare a candidate voice model with the voice in use, on the same line ids:

```
python3 -m pip install -U mlx-audio numpy soundfile          # Apple silicon
python3 -I tools/compare-voice-and-music-models/do-work/say_lines.py <model id> ./candidate ref.wav "the words in ref.wav" \
  l01="First line." l02="Second line."
python3 -m pip install -U torch pyannote.audio
HF_HUB_OFFLINE=0 python3 -I tools/compare-voice-and-music-models/do-work/speaker_similarity.py ref.wav ./current ./candidate
```

`speaker_similarity.py` reads the model from the local Hugging Face cache (`HF_HUB_OFFLINE=1` unless set); set it to 0 once to download. `--pattern` picks which files in each folder are lines (default `*.wav`); `--model` names another speaker model.

Play back a music model's transcription:

```
python3 -I tools/compare-voice-and-music-models/do-work/render_note_events.py events.json playback.wav
```

Events are `{"type": "start", "pitch", "start_time", "index"?, "instrument"?}`, `{"type": "end", "start_event_index", "end_time"}` and `{"type": "drum", "start_time"}`.

Some voice models allow non-commercial evaluation only (the Fish Audio Research License among them); read the model's licence before using what it says. Clone only a voice the person owns or has the speaker's consent for.

Make, master and measure every take of one narration line (the person's settings row lists the takes and the clean, master and ticks commands):

```
python3 -I tools/compare-voice-and-music-models/do-work/say_a_line_in_kokoro.py line.json bm_lewis take-kokoro.wav
python3 -I tools/compare-voice-and-music-models/do-work/say_a_line_in_a_cloned_voice.py line.json qwen3 take-qwen3.wav --ref ref.wav
python3 -I tools/compare-voice-and-music-models/do-work/measure_takes.py line.json take-*.wav
bash tools/compare-voice-and-music-models/do-work/render_takes.sh line.json ./ab settings-row.json
```

A line is `units` (one generation each; `[word](/IPA/)` fixes a word for Kokoro, the clones get the plain word), `pause_after` (seconds after each unit), `inner_most` (the cap on a silence inside a unit, one number or one per unit), `script` (the exact words), and for the measure `hear_prompt`, `voice_reference` and `vowel_check.word` (`test/fixtures/narration-line.json`).

### Settings

Each narration script takes `--settings-record <file>`: the person's `list:settings` row `record:setting:compare-voice-and-music-models~<scope_kind>~<scope_id>` as `records:read` gives it, read by the one settings reader (`node tools/settings/read-data/settings-record.mjs settings-of --record FILE --folder compare-voice-and-music-models`). Its settings go over `DEFAULTS` in `say_a_line_in_kokoro.py`: the models (`kokoro_model`, `clone_engines`, `whisper_model`, `speaker_model`, `accent_model`), `kokoro_speed`, `clone_takes`, `clone_reference`, the levels and lengths (`edge_db`, `quiet_db`, `pause_least_s`, `pause_word_slack_s`, `pitch_floor_hz`, `pitch_ceiling_hz`, `accent_label`, `accent_window_s`), `parselmouth_python`, `whisper_here_dir` (a folder holding a `whisper_here.py` for faster-whisper or openai-whisper where mlx-whisper is not there), and for `render_takes.sh` the `takes` (`{work, name, maker: kokoro, voice}` or `{work, name, maker: clone, engine}`), `clean_command`, `master_command`, `ticks_command` and `measure_glob`. Without a row the defaults are the values the A/B was first run with, under names that name no one.

### Moved from

The narration voice A/B of `source-repo-a` (`kokoro_take.py`, `clone_take.py`, `measure.py`, `render_ab.sh`, at 5a9ba39), first byte for byte (`ports/`), then adapted: the line's narrator, film paths, takes and commands became the person's settings and arguments; the take makers and the measure print a last `{result}`/`{error}` line; refusals replace asserts and import errors; `measure.py`'s pause finder is `pauses_of`; whisper is mlx-whisper or the settings' `whisper_here_dir` instead of a film repository's `tools/place-capabilities`; the render is bash instead of zsh, keeps a replaced take in `work/replaced/` instead of `~/.Trash`, and stops with the reason when a take or the measure fails. Nothing was dropped. Old Trillion made speech the same way (`computer/speak-with-mlx.py:61-80` before 7fd88384: reference audio and its words for a clone, a speaker and `lang_code` for Kokoro; models in `records/speech-engine-records.json:33-57`) but never compared or measured takes.

## Tests

```
node --test tools/compare-voice-and-music-models/test/*.test.mjs
```
