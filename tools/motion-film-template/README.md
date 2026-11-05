# tools/motion-film-template/

The reusable parts of the **motion-film format**: a short film made as one HyperFrames HTML composition, timed from its
recorded voice lines, rendered at two aspects (for example 16:9 and 9:16), with its soundtrack premixed from a cue
sheet so sound and picture read the same times. Films of this format each copied the same build and mix scripts;
this folder holds them once, and each film's own choices are a row of the person's `list:settings`
(`record:setting:motion-film-template~film~<film>`), read through `tools/settings` (`request_settings`; a row named by id is read through the records door by `run-with-settings.mjs`).

A film of the format has: `build.mjs` (its scenes, events and sound cues: the film's own), `template.html.tpl` (its
composition, filled once per aspect into `index.html` and `vertical/index.html`), `assets/js/plan.js` (the timing
plan the composition reads), `audio/cues.json` (the cue sheet), `assets/js/icons.js`, and `assets/soundtrack.wav`
(the premix). Its animation library is GSAP, which a renderer loads itself (`gsap@3.14.2` from npm); it is not in
this repository, whose lockfile admits only SPDX licences (`test/lockfile-licences.test.mjs`).

## Rows

| Row | Does |
|---|---|
| `tool:plan-a-motion-films-soundtrack-premix` | Answers the ffmpeg commands that premix the soundtrack from the cue sheet and the film's settings. Reads and writes nothing. |
| `tool:premix-a-motion-films-soundtrack` | Runs the same premix with ffmpeg on the person's computer and writes the soundtrack, with its loudness pass. |
| `tool:write-the-icon-shapes-a-motion-film-uses` | Writes the film's icons file from the real lucide icons on the person's computer. |

## The premix settings

| Key | Holds |
|---|---|
| `duration` | The film's length, when the cue sheet has no `DUR` (a wordless film's cue list). |
| `music` | `file` (path template: `{sound}`, `{film}`), `start`, `fade_out`, `read_tail`, `bed`, `input_args`, and `chain`: the bed's ffmpeg filter chain, which may name `{DUR}`, `{start}`, `{end}`, `{gain_expr}`, `{fade_out}`, `{fade_out_at}`, `{read_to}`, `{bed}` with Python format specs. |
| `gain` | The bed's gain over time: `base`, `duck` (added while a voice is heard, padded by `duck_pad`), `windows` read in order (the first that sets wins: `set` a gain or `ramp` [from, to]; otherwise base, duck and every matching `add`), sampled `steps_per_second`, times written with `time_format`. |
| `voice`, `cues` | `voice.files` (a path template, `{n}` the line number; a line whose offset is null is a cut line and is skipped), `cues.palette` (the folder of palette sounds, `<name>.wav`), and each `chain` (with `{ms}`, `{gain}`). |
| `mix`, `after_mix` | The summing filter (`{inputs}`, `{DUR}`; by default amix with no normalising, trimmed to the film) and what follows it before the output (for example a one-pass loudnorm or a stereo narrowing). |
| `loudness` | `method`: `none`, `gain-then-limit` (`measure`, `target_i`, `limiter`) or `linear-two-pass` (`loudnorm`, `target_i`, `limit_db`; the default, at -14.5 LUFS with a -1.9 dB limiter). |
| `out`, `work` | Where the soundtrack and the work file go (by default `<film>/assets/soundtrack.wav` and `<film>/audio/premix-raw.wav`). The soundtrack is 48 kHz stereo. |

## Files

| File | Purpose |
|---|---|
| `do-work/premix_soundtrack.py` | The premix: plan, or run with `run: true`. One JSON request on stdin, one answer line. Ported from a film's audio/mix.py (ports/premix-soundtrack.json). |
| `do-work/write-icon-shapes.mjs` | The icons file writer. Ported from a film's build-icons.mjs (ports/write-icon-shapes.json). |
| `test/test_premix_soundtrack.py` | The premix on a made-up film: gain windows, the graph, refusals, and real ffmpeg runs of all three loudness methods on made-up tones. |
| `test/motion-film-template.test.mjs` | The icon writer, the rows, reading a settings row through the stand-in records door, and the Python tests. |

## Dependencies

**Depends on:** `tools/settings` (the settings reader and `run-with-settings.mjs`), `tools/records-door`,
`tools/content-identity` and `@noble/hashes` (packed for the settings reader's door), Node's standard library,
Python 3.10+, ffmpeg (only to run the premix), lucide-react (ISC, on the person's computer, only for the icons).

**Depended on by:** the format row of `list:content-formats`. Each film's own build script (its scenes, events, cues and template fill) stays with the film.
