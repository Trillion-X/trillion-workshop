# parts/ui/show/sound-signal

One live reading of the sound around the person, shared by everything on the page that moves with it (a background behind the panes, the Ambience screen, a card, the person's lights), the looks it moves in, and the controls that tune it.

## Files

| File | Purpose |
|------|---------|
| `sound-signal.ts` | Opens a source once (microphone, a shared tab or screen with its sound, media playing in the page), reads one Web Audio analyser a frame, and hands every listener `{ level, bands, beat, heard, time }`. |
| `sound-sources.json` | DATA: the sources a person can pick (words, icon, how the browser opens it), the frequency bands and the beat rule. |
| `sound-painters.ts` | The motions a look moves in (`sparkles`, `glow`, `waves`, `popcorn`: kernels that burst open with the beat, fly, bounce and pile up): each a painter drawing one frame on a canvas. |
| `sound-looks.ts` | The starting looks (`parts/screen-look/show/sound-looks.json`) and how a kept look `{ look, custom }` is read back and kept (its own name too). Free of the records store, so anything that only draws a kept look (a background layer, a browser extension page) never carries the store or its live connection. |
| `own-sound-looks.ts` | The person's own looks in their records (`own-sound-looks`): `useOwnSoundLooks`, `saveOwnSoundLook`, `OWN_SOUND_LOOKS`. The only file here that reads or writes their records. |
| `sound-targets.ts` | The follower list: things outside the screen (lights) that follow the sound, registered by the page, each sent a colour and brightness no faster than its own pace. |
| `SoundCanvas.tsx` | The one canvas painting a look with the sound (or with any `frames` a caller hands it, such as a page opening); paints only while visible; still for reduced motion. |
| `SoundLayer.tsx` | What the visual layer capability `effect.sound` draws: the kept look, with the chosen lights following. |
| `SoundControls.tsx` | Source picker, look tiles (each a live preview), strength/speed/colour, lights that follow; the same everywhere it is tuned. |
| `index.ts` | Barrel. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `SoundFrame` | `{ level: number; bands: Record<string, number>; beat: boolean; heard: boolean; time: number }` | One moment of the sound. |
| `onSoundFrame` | `(listener) => stop` | Every frame while anything listens; one reading per page. |
| `listenTo` / `stopListening` | `(sourceId) => Promise<SoundState>` / `() => void` | Start or stop hearing a source (start from a press). |
| `onSoundState` / `soundState` | `SoundState = { status: off \| asking \| listening \| refused \| unavailable; source; words }` | Whether it hears, in plain words. |
| `SoundLook` | `{ id, label, about?, motion, palette, ground, strength, speed }` | A look; starting looks are DATA in screen-look. |
| `readSoundLook` / `keepSoundLook` | `{ look, custom }` <-> `SoundLook` | A kept look is its starting look plus only what differs (its label when it is the person's own). |
| `useOwnSoundLooks` / `saveOwnSoundLook` / `sameSoundLook` / `OWN_SOUND_LOOKS` | `() => SoundLook[]` / `(look, name, own) => Promise<SoundLook>` / `(a, b) => boolean` / `'own-sound-looks'` | The person's own looks, on every device; `SoundLookPicker` takes them as `own`. `SoundFollowers` takes `whenNone`, what shows while there are no lights. |
| `registerSoundTargets` / `listSoundTargets` / `followSound` | provider, `(ids, look) => stop` | Lights following the sound; `TargetPaint = { colour, brightness, level, beat, seconds }`. |
| `SoundCanvas`, `SoundLayer`, `SoundControls`, `SoundSourcePicker`, `SoundLookPicker`, `SoundLookTuning`, `SoundFollowers` | React components | The shared pieces. |

## Dependencies

**Depends on:** `#workspace-records` (only `own-sound-looks.ts`), browser Web Audio (`AudioContext`, `AnalyserNode`, `getUserMedia`, `getDisplayMedia`, `captureStream`), `parts/screen-look/show/sound-looks.json`, shared `ui` components (Button, ChoiceTiles, ColorWheel, Container, Slider, Switch, Text).

**Depended on by:** `parts/ui/show/visual-layer-stack/capabilities/sound.ts` (`effect.sound`), `parts/ambience` (screen and followers), `src/workspace/main.tsx` (registers the person's lights).
