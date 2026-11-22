# measure-the-speech-free-stretches

Measures the longest dead-air stretch of a whole clip for a dead-air check. A moment is dead air when its transcript has no speech or its audio is quiet (the union of the two): whisper often runs its words across a silence. No section is exempt.

Speech comes from the whisper transcript's segments with words in them (a blank segment is not speech). Quiet comes from the clip's audio, using measure_prosody.py's frame levels. Each stretch says which source flagged it. The threshold is applied by the caller's compare step (2.0 s), not by this tool.

| File | Purpose |
|------|---------|
| `do-work/measure_speech_free.py` | The measure. Prints `{"result": {...}}` or `{"error": ...}`. |
| `test/test_measure_speech_free.py` | Made-up transcripts and audio: a silence the transcript runs across, a music-only tail, a blank segment, and the refusals. |
| `tool-rows.json` | The one Workshop row, `tool:measure-the-speech-free-stretches`. |
| `kits/measure-the-speech-free-stretches.json` | The kit (L082). |
| `part.json` | Nothing here is imported by other code. |

Run: `python3 -I tools/measure-the-speech-free-stretches/do-work/measure_speech_free.py transcript.json clip-16k.wav`
Test: `python3 -I -m unittest discover -s tools/measure-the-speech-free-stretches/test -p 'test_*.py'`
