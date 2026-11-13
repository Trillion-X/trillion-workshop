# tools/record-video-with-teleprompter

Recording a video of oneself with the camera: countdown, silence stop, a teleprompter that follows the person's speech, a voice-only choice, a live waveform, and a script their AI writes for a chosen format. The recording screen (`show/`) needs a browser; turning a presentation plan into the recording session it runs (`do-work/recording-session-from-presentation-plan.mjs`) runs anywhere, and it is what the row runs.

## Files

| File | Purpose |
|------|---------|
| `do-work/recording-session-from-presentation-plan.mjs` | `recordingSessionFromPlan({ plan, readiness, authorization, nowMs })`: one compiled video presentation plan becomes the recording-session DATA the screen reads, auto-start only with fresh readiness and an unexpired grant; `presentationReadinessFromObservations` decides readiness from the setup pass (what `tool-rows.json` runs) |
| `do-work/build-recording-session-from-presentation-plan.mjs` | The same conversion as a command: `--plan <json> --out <json> [--readiness <json>] [--authorization <json>] [--now-ms <ms>]` |
| `do-work/record-video-requests.ts`, `do-work/recorded-file-store.ts`, `do-work/recorded-file-artifact.ts` | Owner-action requests, the chunk store and artifact writes (browser and workspace) |
| `read-data/` | The recording session decoder and recording page arrangement the screen reads |
| `show/` | The recording screen (`RecordVideoPanel.tsx`) and its capture, silence stop and live recording helpers |
| `things-to-store-and-run.json` | Package data: surface, actions, descriptors and the `recordings` input |
| `tool-rows.json` | The row `tool:turn-a-presentation-plan-into-a-teleprompter-session`, with a sample run of a two-sentence plan with complete readiness and an unexpired grant, so the session may start by itself |
| `README.md` | This file |
| `show/record-video-screen-mount.tsx` | `tool:screen-record-video` as a screen module: its one export, `mount`, is the Record video screen below |
| `web/src/workspace/record-video-screen.tsx` | The Record video screen: the recording panel with the person's takes, the script and the page a recording opens on; moved here byte for byte from the web client (`moved-from.json`) |
| `web/src/workspace/record-page-screens.json` | The screens a recording's page opens on |

## The row

`tool:turn-a-presentation-plan-into-a-teleprompter-session` runs `recordingSessionFromPlan` in a small container with no internet. It reads only its input: it opens no camera or microphone, records nothing and asks no AI to write a script.
