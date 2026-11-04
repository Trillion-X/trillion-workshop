# parts/ambience

Ambience: the screen, the space behind the panes and the person's lights moving with the music or the sound around them, and what fills the shared follower list (`parts/ui/show/sound-signal`) with the person's own lights and music services.

## Files

| File | Purpose |
|------|---------|
| `part.json` | What other parts and `src/` may import (`public`): `show/sound-followers.ts`. |
| `read-data/sound-followers.json` | DATA: each light service (`lights`: how its lights are listed or fixed, how often each may be sent to, the quiet Workshop row that sets one and its input template) and each music service that says what is playing (`playing`: its quiet row and the paths to title, artist, picture). A new service is one row here plus its tool rows. |
| `show/sound-followers.ts` | `followLights()` (the person's lights as follow-the-sound targets, read at most once a minute) and `nowPlaying()` (what the first connected music service says is playing), both through `POST /work/api/workshop/send-quietly/<tool>`. |
| `show/ambience-screen.tsx` | The Ambience screen (`tool:screen-ambience`, `/ambience`; opened with `listen=computer` in its input or address it leads with Hear your music): Put behind my screens / Take it away (screen-arrangement's `askBehindPanes` on `effect.sound`, buttons saying their work), Where your music plays (pictures from `music`, a press listens to this computer), Save as my look (the person's own looks, `useOwnSoundLooks`), lights in plain words with Connect your lights when there are none, How Trillion talks (`voices-panel.tsx`); the look full-bleed over the stage moving with the sound, what is playing or the look's name over it with previous/next look (its words take black or white, whichever stands out more from the look's own stage ground, `wordsOver`), and the shared controls beside it (below it on a narrow pane). The stage follows the pane body's inner corner (`data-corner-follows`, screen-look `nested-corners.css`), so where it fills a corner it curves with the pane. Module-screen contract `mount(element, { surfaceInput })`. |
| `show/voices-panel.tsx` | How Trillion talks, inside Ambience: choose the voice it speaks in, each voice's speed (the shared SpeedControl, 0.1x to 16x, fine or by preset steps) and, per place it speaks (said out loud, calls, voice messages, podcasts, posts, the car, coaching, any place added), a different voice or speed. Reads `tool:voice-for` through `POST /work/api/workshop/send-quietly/tool:voice-for` and writes the person's own list rows through `POST /work/api/lists/<list>/rows` (src/voices.mjs owns them); keeps nothing itself, one write per settled change. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `followLights` | `() => Promise<SoundTarget[]>` | Handed to `registerSoundTargets` by `src/workspace/main.tsx`, so any background moving with sound can have the person's lights follow. A service not connected simply has no lights. |
| `musicPlaces` / `lightKinds` | `MusicPlace[]` (`{ id, label, page, picture }`) / `string[]` | The places music plays, and the lights that can follow in plain words, both from `sound-followers.json`. |
| `nowPlaying` | `() => Promise<NowPlaying \| null>` | `{ service, title, by, picture, playing }` from the first `playing` row that answers. |
| `VoicesPanel` | `() => JSX` | The voice and speed controls, over the person's Voices list and their list of places Trillion speaks. |
| `NowPlaying` | `{ service: string; title: string; by: string \| null; picture: string \| null; playing: boolean }` | What is playing. |
| `mount` | `(element, { surfaceInput }) => () => void` | Draws the Ambience screen; keeps the look and the lights that follow on this device as `{ look, custom, following }` (key `trillion-ambience`), the same shape a background layer keeps. |
| light row | `{ id, label, fixed? \| list?: { tool_id, input, items, id, label, keep }, every_ms, set: { tool_id, input } }` | `set.input` is a template: `{ paint: colour \| rgb \| lit_rgb \| brightness \| percent \| seconds }`, `{ item: <kept fact> }`, `{ join: [...] }`. |

## Dependencies

**Depends on:** `parts/ui/show/sound-signal` (the one sound reading, painters, looks, controls, follower list), `parts/ui` (Button, Container, NamedIcon, Text, DisclosureSection, Dropdown, SpeedControl, `mountSharedContent`), `src/voices.mjs` through tool:voice-for and the lists road, `src/workspace/api.ts` (`postJson`), the Workshop rows in `records/workshop-ambience-tool-records.json` (runs_quietly), `src/work-workshop.mjs` + `src/workshop.mjs` `sendQuietly`.

**Depended on by:** `src/workspace/main.tsx` (registers `followLights`), the screen row `tool:screen-ambience` in `records/workshop-screen-tool-records.json`.
