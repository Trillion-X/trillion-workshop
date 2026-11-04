# tools/make-things-feel-good

The screens that make things feel good: old trillion's `parts/delight-moments/` (a small good moment, one line of words with a motion, when something good happens or a phrase is typed), `parts/feel/` (a feel in touch, sound and motion for every happening, on each device, under the person's show rules) and `parts/ambience/` (the screen and lights following music or sound), whose own READMEs are in `delight-moments/`, `feel/` and `ambience/`. The screens need the workspace and a browser; the row runs the part that needs neither, the pick of the moment.

## Files

| File | Purpose |
|------|---------|
| `do-work/pick-a-moment.mjs` | `pickAMoment({ moments, event? \| typed?, memory? })` → `{ moment, remember }`: `read-data/choose-moment.mjs` (`chooseMoment` for an event, `typedMoment` for typed text) run once over the rows given (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:pick-a-small-good-moment`, with a sample run where the once-only moment has played and the rotating words move on |
| `README.md` | This file |

`read-data/choose-feel.mjs` now imports `rowAnswers` from `./choose-moment.mjs` beside it (the same bytes as old trillion's `parts/delight-moments/read-data/choose-moment.mjs`) instead of `../../delight-moments/read-data/choose-moment.mjs`, which is not in this folder.

## The row

`tool:pick-a-small-good-moment` plays, shows, stores and sends nothing and reads no clock: the caller keeps `remember` and gives it back as `memory`. Playing the motion, the feel's touch and sound, and the lights stay with the screens.
