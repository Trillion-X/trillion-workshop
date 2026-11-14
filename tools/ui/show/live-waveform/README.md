# live-waveform/

**Depended on by:** `../recording-bar`, `../composer`, `parts/record-audio/show/RecordAudioPanel.tsx`, `parts/record-video/show/RecordVideoPanel.tsx`.
**Depends on:** `../cn`, the browser's AudioContext and canvas.
## Dependencies
| Name | Shape | Role |
|------|-------|------|
| `LiveWaveform` | `({ stream, active, processing, frame, edgeFade, className, 'aria-label' }) => JSX` | The live waveform; `role="img"` with its label. |
| `LiveWaveformProps` | props above | `frame` is `'outlined'` (bordered well) or `'flat'`; `edgeFade` fades both edges through the look's `screen-edge-fade-x` (its depth per edge is the look token `--screen-edge-fade-start` / `--screen-edge-fade-end`). |
## Key Types / Functions
| File | Purpose |
|------|---------|
| `LiveWaveform.tsx` | The waveform: reads the stream's time-domain samples through an AnalyserNode, keeps the loudness history, paints it on a canvas every frame. |
| `index.ts` | Exports `LiveWaveform` and its props. |
## Files
It draws the sound over time, the way a voice memo does: one loudness every 50 ms
as a thin bar, the newest at the right edge, the wave sliding left as it is heard
(the scrolling mode of ElevenLabs UI's live waveform, MIT). Loudness uses the
iPhone's scale (`ios/Shared/Waveform.swift` `level(decibels:)`), so a voice draws
the same height on every device. Paused, the wave stays where it was in the quiet
colour; before any sound it is a row of quiet dots; `processing` draws a moving
wave while a recording is being finished.
Browser-local waveform visualizer for caller-owned `MediaStream` objects.

It does not request microphone access, choose colors, store audio, invoke
workflow, or import any owner package. It reads active screen-look CSS variables
from its mounted DOM node and uses canvas only for browser pixel drawing.
