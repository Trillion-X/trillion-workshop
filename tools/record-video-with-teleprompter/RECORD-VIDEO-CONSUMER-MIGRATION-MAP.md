# Record Video Consumer Migration Map

State: source prepared on 2026-08-15 for lane tasks #157/#158. Live admit and runtime wiring still belong to task #171.

## Already consuming the shared output primitive

| Consumer | Current source truth | Note |
|---|---|---|
| `audio-transcription` | Reads `record-action-projection.record` and filters by `capture_mode`. | No package-name coupling remains. |
| `media-analysis` | Reads the unified record/action feed and describes `record-audio`, `record-video`, and `screen-recording` as one shared source family. | No teleprompter-specific change required for source prep. |
| `content-production` | References `record-audio` and `record-video` directly in source. | Split already reflected. |
| `media-composition` | References `record-audio` and `record-video` directly in source. | Split already reflected. |

## Remaining follow-through after this lane

| Surface | What remains | Why it is not done in this lane |
|---|---|---|
| `record-video` live runtime | Admit and wire the `recording-session` value into the active engine/runtime path. | User explicitly scoped this lane to source only and said it rides #171 for live. |
| Standalone founder HTML tool | Retire only after the package-backed replacement is admitted and proven live. | L101 sequence: replacement first, retirement second. |
| Any consumer that wants founder-session awareness | Read `recording-session` as DATA only if it needs teleprompter-specific behavior. | The shared recorded-file output already stays generic. |
| `motion-analysis` note about recording-session | Revisit only if that package needs the teleprompter session itself rather than the saved recording output. | Current source shows only a comment, not an active dependency. |
