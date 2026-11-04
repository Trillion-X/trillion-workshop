# tools/record-cameras-and-microphones-all-day

Recording every camera and microphone on a device without anyone pressing record: each input switched on records without end, cut on the clock into pieces that line up across devices, kept on the device first and sent into the person's Files. The recorder (`always-recording.ts`) needs a browser; the piece arithmetic (`rolling-segments.mjs`) runs anywhere, and it is what the row runs.

## Files

| File | Purpose |
|------|---------|
| `always-recording.ts` | The recorder: opens every input, cuts each on the clock, keeps every piece on the device and sends it while recording, reopens an input that stops (browser only; imports files this folder does not hold) |
| `rolling-segments.mjs` | The arithmetic of recording that never stops: the clock window a moment falls in, an input's name, where a piece is kept and the session list |
| `plan-recording-pieces.mjs` | `planRecordingPieces({ started_at, until, segment_seconds, folder, inputs, device, list_name, time_zone })`: every input's pieces for a stretch, named and placed, and the session list (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:plan-clock-aligned-recording-pieces`, with a sample run whose first piece starts at 16.23.10 and is cut at 16.25.00 |
| `README.md` | This file |

## The row

`tool:plan-clock-aligned-recording-pieces` runs `plan-recording-pieces.mjs` in a small container with no internet. It reads only its input: it opens no input, records nothing and sends nothing.
