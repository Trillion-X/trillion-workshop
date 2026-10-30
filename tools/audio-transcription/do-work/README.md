# Audio Transcription Do Work

Workflow request builders and process descriptors for audio transcription, plus the audio.master capability executable.

## Files

| File | Purpose |
|------|---------|
| `submit-audio-transcription.ts` | Builds + sends the transcription workflow request |
| `process-scripts/` | Process-output record scripts |
| `audio-master.mjs` | T15 audio.master: highpass → TWO-PASS loudnorm (measure, then apply measured values) → true-peak limiter AFTER loudnorm → measurement-gated afftdn denoise. Every number a named param (`--target-lufs -14`, `--true-peak -1.0`, `--lra 11`, `--highpass-hz 80`, `--denoise auto`). Emits before/after LUFS/TP report JSON. Run by `action:audio-master` via compute.process |
| `__tests__/audio-master.test.mjs` | 6 tests on deterministic lavfi fixtures: quiet→±1 LUFS of target, hot→TP ≤ ceiling, param overrides, denoise gating, zero magic numbers |

## Rules

- This folder owns audio-transcription request shape and process-output records.
- Shared content/media staging comes from content-media-evidence.
- compute.process inline input encoding comes from `@bitfield/runtime-kit/protocol`; this folder must not copy byte encoders.
