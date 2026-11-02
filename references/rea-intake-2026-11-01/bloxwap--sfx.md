# bloxwap/sfx

- Source: https://github.com/bloxwap/sfx @ 1d9a5b642ac3e44abb32586513cd80779602f2ec (2026-10-31)
- Licence: MIT. Root `LICENSE` and `packages/sfx/LICENSE` are both MIT ("Copyright (c) 2026 Bloxwap"); the published package `@bloxwap/sfx` 0.2.1 declares `"license": "MIT"` in `packages/sfx/package.json`. The workspace root and `apps/docs` are `private` and declare no licence. The docs app depends on `@bloxwap/font` (OFL-1.1 in its own repo) and on other `@bloxwap/hig-*` packages, but no font files are vendored in this repo. The four WAV files in `packages/sfx/assets/hig/` are rendered from the package's own recipes (`assets/hig/manifest.json`) and ship inside the MIT package. The repo has no vendored third-party code, and the package has zero runtime dependencies. **Copying code into an Apache-2.0/MIT project: yes, with the MIT notice.**

## What it does
`@bloxwap/sfx` makes interface sound effects (19 named sounds such as `tick`, `press`, `toggle`, `success`, `error` and `payout`) live with the Web Audio API, with no audio files. Each sound is a data recipe of oscillator and filtered-noise layers. It is rendered once with an `OfflineAudioContext`, cached, and then played as a single `AudioBufferSourceNode` through a master gain and limiter bus. The entry points are:
- `.`: `play`, `preload`, `bind`, `define`, volume and mute controls, `renderTo`, `renderBuffer`
- `./recipes` and `./semantic`
- `./wav`: `encodeWav`, `trimSilence`
- `./react`: hooks and a provider with preferences that persist in localStorage
- an `sfx-wav` CLI that renders the sounds to WAV files in Node via the optional peer `node-web-audio-api`

It is ESM-only and a silent no-op on the server.

## How it is built
- Monorepo with the library in `packages/sfx` (about 1,750 lines of TS) and a Next docs app in `apps/docs`.
  - `src/recipes.ts`: the sound table as frozen data, plus `registerRecipe` validation, `duration` and `echoTail`
  - `src/engine.ts`: context and bus setup, offline baking and caching, voice cap, retrigger guard, resume queue, AbortSignal per play
  - `src/bind.ts`: delegated `data-sound-*` listeners
  - `src/wav.ts`: the WAV encoder and silence trimmer
  - `src/cli/index.ts`: argument parsing with `node:util` `parseArgs`, using injectable `RunDeps` for the loader, fs, logging and cwd
  - `src/react.ts`
- Tests run with `node --test` straight on `.ts` files, with a 100% line/branch/function coverage gate in `package.json` scripts. Playwright browser tests are in `test/browser`.
  - `test/fake-audio.ts` is a recording stand-in for Web Audio: every node, connection and parameter event is kept.
  - `test/wav-reference.ts` is a frozen pre-optimisation encoder, and `wav.test.ts` asserts byte equality with it.
  - `test/cache-equivalence.ts` seeds `Math.random` with an LCG to compare cached and live renders.
  - `test/hig-assets.test.ts` checks the committed WAVs against the manifest: SHA-256, recipe hash, RIFF header fields, peak, RMS and duration bounds.
- Benchmarks are in `bench/`. A large `evidence/` folder holds screenshots and logs from past changes.

## Reusable techniques worth learning
1. **Dependency-free WAV encoder (16/24-bit PCM, 32-bit float)**, in `src/wav.ts` (`encodeWav`). It writes RIFF/`fmt `/`data` with a `DataView`, adds the `fact` chunk that float WAV requires, and adds a pad byte when the data chunk has an odd size. It quantises asymmetrically so that −1 and +1 hit the exact ends of the integer range, and clamps NaN to silence. Channels are written at an interleaved stride, and a mono downmix is done in Float64 first. It rejects files over the 4 GiB limit with a `RangeError`. This is a correct, compact reference for anything that writes audio.
2. **Peak-relative silence trimming**, in `src/wav.ts` (`trimSilence`). It finds the global peak, sets the threshold at `peak·10^(dB/20)` (default −60 dB), scans each channel backwards for the last sample above it, keeps a pad (default 20 ms), and never lengthens the buffer. Because the threshold is relative to the peak, it works for quiet and loud renders alike.
3. **Committed-asset manifest with content checks**, in `test/hig-assets.test.ts` and `assets/hig/manifest.json`. Each generated file has its SHA-256, the hash of the recipe that made it, frames, peak and RMS recorded. The test re-reads the bytes and checks the header fields, recomputes peak and RMS, and asserts sanity bounds (`0.01 < peak < 1`, 20 ms < duration < 2 s). The manifest also states plainly that regenerations are not byte-identical. This guards generated media against silent corruption and silent output.
4. **Frozen reference implementation as a byte-for-byte oracle**, in `test/wav-reference.ts` and `test/wav.test.ts`. The pre-optimisation encoder is kept in the test tree, and the optimised encoder must produce identical bytes across formats and inputs. It is a cheap, strong guard when optimising an encoder or serialiser.
5. **Recording fake for a stateful browser API**, in `test/fake-audio.ts`. `FakeParam` records `set`, `exp` and `target` events with times, and `FakeNode` records `connect`/`disconnect` calls. Tests then assert on the exact audio graph and automation without making sound. The same pattern works for any imperative API you cannot run in CI.
6. **Render once, then play a cached buffer, with in-flight dedupe**, in `src/engine.ts` (`render`, `deferRender`, `start`). The first play of a sound synthesises it live and starts an offline render in the background. Later plays reuse the buffer. A render already in flight is shared through a `Map<name, Promise>`, and `dispose()` or a recipe redefinition invalidates late results. This is a generic memoise-the-expensive-build pattern with proper invalidation.
7. **Delegated declarative binding with one handled-event set**, in `src/bind.ts`. It adds one capture listener per event type on the root and finds the carrier with `closest(selector)`. A `WeakSet<Event>` stops nested roots from playing the same event twice. Disabled, `aria-disabled` and `inert` controls are skipped. A keyboard release plays only if the same element got the press. Binding the same root twice returns the existing unbind. It is a small, robust "behaviour from data attributes" recipe.
8. **Testable CLI with injected I/O**, in `src/cli/index.ts` (`RunDeps`). The loader, fs, log, error and cwd are all optional parameters, so tests run the real argument parsing and planning with fakes. Names are validated by a regex (`NAME`) before they become file paths.

## Fit with trillion-workshop tools
- **`tools/generate-speech`** (`do-work/local_voice_provider.py`, `speak()` and `duration_ms()`). A voice program counts as successful when `os.path.getsize(out_path) > 0`, so a header-only WAV with zero frames, or an all-silent one, is reported as speech, and the chain does not try the next engine. Techniques 2 and 3 suggest a small check with the standard-library `wave` module: treat zero frames, or a peak below a floor (for example all 16-bit samples equal to 0), as "made no audio" and move on to the next engine. The existing test stub "writes half a second of silence", so the fixture would need to write a short tone, plus a new case for the silent file. This is the best small change for this repo.
- **`tools/grade-and-repair-speech-audio`** already measures audio in Python (`read-data/measure.py`). Technique 3's manifest pattern (hash, peak, RMS and duration bounds pinned in a test) could guard its synthetic fixtures, but I did not check whether it already does. It is listed as a possibility, not a confirmed gap.
- The browser-side engine, binding and React parts have no counterpart among the tools. Technique 1 matters only if a JS tool ever needs to write WAV, and none does today: `generate-speech` uses Python's `wave`.

## Cautions
- The engine only works in a browser (Web Audio, `navigator.userActivation`, `visibilitychange`/`pageshow` resume handling). In Node it needs the optional `node-web-audio-api`.
- Noise layers use `Math.random`, so renders are not byte-reproducible (the manifest says so). Do not hash rendered audio as a determinism check unless you seed it the way `test/cache-equivalence.ts` does.
- `src/semantic.ts` pins an external `bloxwap/hig` commit for its intent table. That is a design-system dependency, not something to adopt.
- `evidence/` holds screenshots and logs that are only useful to this project's own review process. Ignore it.
- The 100% coverage gate and the `tsrs` dev toolchain (`tsrs` 0.18.0-ts7 pre-release) are project choices and are not needed to reuse any technique.
