# compare-voice-and-music-models

Scripts a person's AI runs on the person's own computer to try a candidate voice or music model before adopting it. Nothing here picks a model: each script makes or measures audio so the person can compare.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | Three Workshop rows, all `on-your-computer`: `tool:say-lines-in-a-candidate-voice-model`, `tool:score-how-alike-lines-sound-to-a-reference-voice`, `tool:render-music-note-events-to-a-test-wav`. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/say_lines.py` | Evaluation only: says lines in a voice-cloning model mlx-audio loads (Apple silicon), cloned from a reference recording; one WAV per line. |
| `do-work/speaker_similarity.py` | Scores each line in one or more folders against the reference recording with the WeSpeaker ResNet34 speaker model (cosine of voice embeddings). |
| `do-work/render_note_events.py` | Test-only: renders a music transcription's JSON note events to a plain 48 kHz stereo WAV for an audio meter to measure. |
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

## Tests

```
node --test tools/compare-voice-and-music-models/test/*.test.mjs
```
