# media-playback/

The shared player every video and sound in Trillion plays in, brought from bitfield-packages `packages/media-playback` (commit c8c5c88f4) with its one alias import pointed at `../../ui/show/expandable-tabs`. The package's hosts, transcript readers, queues and tests were not brought in.

Completion uses `parts/ui/show/playback-completion.tsx` and the existing Screen Look media appearance. It reserves the controls' measured `--media-playback-controls-inset`; short pictures scroll the completion card above the still-available seek, mute, speed and fullscreen controls. `test/player-completion-browser.test.mjs` exercises normal pointer Restart, extra completion actions and transport controls at phone and desktop widths under both motion preferences.

The completion repair searched the live 21st.dev registry for `video player controls` and read Video Player component38216 (ebnsina/Sina UI). It retained the existing controls and reused Coss's MIT Button at source commit `e937becd2d5ffb5c621eed6f8b1f223cbb6051e7`; no registry code or media was copied. Coss provenance and license stay in `parts/ui/show/coss/`. Mobbin tools were unavailable in that session. The retained reference informs the control inventory, not a claim of identical layout or measured user benefit.

## Files

| File | Purpose |
|------|---------|
| `show/MediaPlaybackSurface.tsx` | The player: video and sound faces, its own controls (play, seek bar, volume, speed, fullscreen for a video), captions and transcript over a video, completion actions, private-delivery states. Reads the media at `playback_url` with the browser's range requests. A video plays in its picture box; a sound has its own face on the page's surface (no picture box, no fullscreen): the controls in their `sound` look with the sound's waveform as the seek bar (made from the sound by the one preview maker, `ui/show/media-preview` `readOrMakePreview`), and its timed words under it in the one transcript reader's `under-sound` layout, the word being said marked and each word a place to play from. Timestamped passages retain speaker names and offer the shared speaker selector when more than one speaker is present; transcript rows remain virtualized and filtered seeks keep the original timeline index for auto-follow. |
| `show/MediaFrame.tsx` | The frame an embedded (iframe) source plays in. |
| `show/PlaybackControls.tsx` | The one set of controls: time, seek, play, volume, speed, fullscreen, transcript, captions, drawn in a look (`over-picture` over a video, fading with the pointer; `sound` on a page surface with a large round play and the waveform as the seek bar). A look is a set of class names on the same parts (`LOOKS`). `fitPeaks` merges peaks to the bars the width holds. |
| `show/class-names.ts` | Joins class names. |
| `read-data/read-media-playback.ts` | `MediaSourceRecord` and the embed-control types the player reads; reading published playback records. |
| `read-data/measure-media-length.ts` | `measureMediaLength(url, kind)`: how long a sound or video file plays, read from the file's own metadata by the browser decoder (nothing plays); null when it cannot say, never a guess. |
| `read-data/private-object-request.ts` | The one on-screen state for a private file's delivery reply, in plain words. |
| `part.json` | Public files: `show/MediaPlaybackSurface.tsx`, `read-data/measure-media-length.ts`. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `MediaPlaybackSurface` | `(props: MediaPlaybackSurfaceProps) => ReactElement` | The player; `media: { id, label, source_kind: 'video' \| 'audio', mime_type, playback_url, poster_url }`, `autoPlay`, `preload` (`none`, `metadata` or `auto`), `showFrameChrome`, `seekRequest`, `timedTextSegments`. Its box carries `data-media-playback-kind` and the video's shape as `--media-aspect`. |
| `FullscreenTimedTextOverlay` | `({ currentTime, layout?: 'side-panel' \| 'under-sound', onSeek, segments, title, visible })` | The one transcript reader: search, the current word marked (`data-fullscreen-transcript-word-active`), a word clicked plays from it; the list follows the words by scrolling itself. `side-panel` lies over a picture's side; `under-sound` is laid out under a sound, with a search box once there are more than six passages. |
| `PlaybackControls` | `(props: PlaybackControlsProps) => ReactElement` | `look?: 'over-picture' \| 'sound'`, `peaks?: readonly number[]` (the seek bar drawn as the waveform, played part filled); fullscreen, transcript and captions appear when their handler is given. |
| `TimedTextSegment` | `{ id, text, start_ms?, end_ms?, speaker?, words?: { word, start, end }[] }` | One timed passage, optionally assigned to a speaker; word times are seconds. |

## Dependencies

**Depends on:** React, lucide-react, framer-motion, `@radix-ui/react-popover`, `../ui/show/expandable-tabs`, `../ui/show/dropdown` (speaker selection), `../transcript-reader/read-data/read-transcript-records` (speaker discovery/filtering), `../ui/show/media-preview` `readOrMakePreview` (a sound's waveform), `../screen-ready-records` (types only).

**Depended on by:** `../ui/show/file-preview/FilePreview.tsx` (every file opened in the workspace and the show_file view). Tested in `test/sound-face.test.mjs`.

Caption and transcript readers share `parts/ui/show/virtual-list` measured windowing, with three overscan rows. Their scrollable content stays reachable; the caption viewport is named Captions and the transcript list exposes the full filtered count and each mounted row position. Manual wheel/touch/keyboard/focus pauses following; a word seek resumes it, including seeking the same word. Caption position, resize, color/background/type controls and transcript search remain on the existing readers. Inactive memoized rows receive no playback-time prop; only the active row and changed word states repaint. `read-data/timed-text-index.ts` caches source-order interval envelopes, preserving first matching inclusive boundaries, overlapping and unsorted ranges. Ordered timelines query logarithmically; arbitrary ranges retain the safe worst-case scan. `test/timed-text-readers-browser.test.mjs` renders the real readers in Chromium at180/1800/18000 variable-height passages and measures seeks/search/focus/tick work.
