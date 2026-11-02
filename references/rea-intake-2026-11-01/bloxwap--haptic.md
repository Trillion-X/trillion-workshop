# bloxwap/haptic

- Source: https://github.com/bloxwap/haptic @ 5f8e21632a64137b90e77ada645f9b9c846f9e1e (2026-10-27)
- Licence: MIT. Root `LICENSE` and `packages/haptic/LICENSE` are both MIT ("Copyright (c) 2026 Bloxwap"); the published package `@bloxwap/haptic` 0.3.0 declares `"license": "MIT"` in `packages/haptic/package.json`. The workspace root and `apps/docs` packages are `private` and declare no licence. The one runtime dependency, `web-haptics` 0.0.6, is MIT according to `package-lock.json`. `src/presets.ts` is a literal copy of `web-haptics`' `defaultPatterns`, and `src/trigger.ts` re-implements its 20 ms PWM encoding. Both are MIT on MIT. `.github/planning/COMPATIBILITY.md` says the package is an independent re-implementation of `@joeblau/haptic` 0.1.0 (also MIT, per `EVALUATION.md`) and that "its algorithms were not inspected or ported". The repo has no vendored third-party code and no fonts. **Copying code into an Apache-2.0/MIT project: yes, with the MIT notice.**

## What it does
`@bloxwap/haptic` is a small React (18/19) wrapper that adds tap feedback to any single child element. Entry `.` exports `Haptic`/`HapticTarget`, `isIOSWebKitWithoutVibration`, `useIOSNativeHaptics`, `canTriggerHaptic` and `triggerHaptic`. Entry `./feedback` has no React or platform imports and exports `createHapticAdapter`, `createNativeHapticAdapter` (it takes an Expo Haptics module) and `semanticHaptics`. On browsers with the Vibration API it sends vibration patterns through `web-haptics`. On iOS/iPadOS WebKit, which has no `navigator.vibrate`, it lays an invisible native `<input type="checkbox" switch>` with a label over the target. A real tap then toggles the switch, which plays the system haptic tick, and the click is forwarded to the original element. ESM and CJS builds are made with tsup.

## How it is built
- Monorepo with the library in `packages/haptic` and a Next/Fumadocs docs app in `apps/docs`. The library is about 430 lines across 6 source files:
  - `src/haptic.tsx`: the component, a capture-phase click listener, and the iOS switch overlay with drag cancellation
  - `src/platform.ts`: iOS routing via `useSyncExternalStore`, which is hydration-safe
  - `src/trigger.ts`: imperative `canTriggerHaptic` and `triggerHaptic`, returning reason codes
  - `src/presets.ts`: the preset literal
  - `src/feedback.ts`: the semantic-intent adapter
- Tests: Vitest with jsdom (`test/*.test.ts(x)`), plus Playwright in Chromium, Firefox and WebKit with axe accessibility checks (`test/browser/interaction.spec.ts`).
  - `test/presets.test.ts` checks that the local preset copy still matches upstream.
  - `test/dependency.test.ts` replays recorded `navigator.vibrate` calls from `.github/planning/reference-observations.json`.
  - `scripts/react-matrix.mjs` tests across React versions.
  - `scripts/pack-check.mjs` packs the tarball, enforces an exact file allowlist and the runtime-dependency list, installs it into throwaway React 18 and 19 consumers, and type-checks, imports and SSR-renders it there.
  - `scripts/size.mjs` sets an 8 KiB gzip budget.
- CI scripts in `.github/scripts/` include `wait-for-registry.mjs` (polls npm until the version and dist-tag appear), `check-publish-auth.mjs` and `release-check.mjs`, each with its own `*.test.mjs`.

## Reusable techniques worth learning
1. **Capability probe that returns a reason, not a boolean**, in `src/trigger.ts` (`canTriggerHaptic`, `triggerHaptic`). Before acting, the code checks the environment in order: no browser, then document hidden, then Vibration API without user activation, then iOS needing a trusted tap, then unsupported. It returns `{ available, mechanism, reason }`. The trigger never throws, and its result separates "the browser accepted it" (`delivered`) from "the person felt it". Worth learning because callers and logs get an exact, testable cause instead of a silent no-op.
2. **Intensity as pulse-width modulation over a 20 ms duty cycle**, in `src/trigger.ts` (`vibrationPattern`). The API only knows on/off durations. So each event with intensity `s` becomes repeated `[round(20·s), 20 − round(20·s)]` pairs, with the remainder handled and delays merged into the "off" slots. Input is validated, and anything non-finite returns `null`. It is a neat way to fake amplitude on a binary actuator.
3. **Hydration-safe platform routing with `useSyncExternalStore`**, in `src/platform.ts`. A no-op subscribe and a server snapshot of `false` mean the server and the first hydration render agree. The client value is resolved only after hydration, which avoids mismatch warnings without a `useEffect` flag. Any React code that branches on user agent or capabilities can use this.
4. **Semantic intent to cue table with silent phases, behind an injected backend**, in `src/feedback.ts` (`semanticHaptics`, `createHapticAdapter`). Intents such as press, activate, success and error map to a cue or to `null`, so some phases stay silent on purpose. The adapter drops events that are cancelled, disabled, busy, suppressed or in the background. Every backend call is wrapped so it cannot reject the host action. Platform code (browser, Expo) is passed in as a backend. This keeps policy separate from delivery.
5. **Drift test for a copied upstream constant**, in `test/presets.test.ts`. The local literal is `toEqual`-compared with the upstream export, so an upstream change breaks the build instead of drifting silently. It is a one-line guard for any table you copy from a dependency.
6. **Recorded-observation contract tests**, in `test/dependency.test.ts` and `.github/planning/reference-observations.json`. Real outputs of the reference (here, the exact arrays passed to `navigator.vibrate`) are recorded as JSON once. The tests replay each case against the code with a stubbed global. This pins behaviour without copying the reference's algorithm.
7. **Tarball allowlist and isolated-consumer check**, in `scripts/pack-check.mjs`. It runs `npm pack --json`, then requires an exact regex allowlist of published paths and an exact runtime-dependency set. It then installs the tarball into a temp project per React major and checks ESM, CJS, types and SSR there. This catches packaging bugs that unit tests cannot see.
8. **Injectable clock, sleep and fetch for polling with a deadline**, in `.github/scripts/wait-for-registry.mjs`. The poller takes `{ fetch, now, sleep, timeoutMs, intervalMs, onWait }`, says what it is still waiting for, and fails with the last pending reason at the deadline. `wait-for-registry.test.mjs` drives it with fakes. It is a clean, testable shape for any "wait until X is visible" step.

## Fit with trillion-workshop tools
- No workshop tool uses vibration or haptics (a search of `tools/` for `vibrate|vibration|haptic` returns nothing), so none of the component code fits directly.
- **`tools/notifications`**: technique 4 (an intent table with deliberate silent phases, and adapters that cannot reject the host action) and technique 1 (reason codes; delivered does not mean felt) match its stance that "a provider accepting a push does not mean the person saw it". The tool already follows that stance, so this confirms the design rather than proposing a change.
- **`tools/check-bundle-package-boundaries`**: technique 7 (exact published-file allowlist) is close in spirit, but that tool judges an esbuild metafile, not an npm tarball. Adding tarball checks would be a new feature, not a small change.
- Technique 8's injectable polling shape could serve any tool that waits on an external system, but there is no single obvious small target. **No small change is proposed for this repo.**

## Cautions
- The iOS path depends on WebKit playing a system tick when a native `switch` checkbox is toggled by a trusted tap. That is platform behaviour, not a documented haptics API, and it could change. The repo itself keeps "physical certification" open (`COMPATIBILITY.md`, issue #9).
- `useCommittedEffect`, the overlay and the label handlers are tied to React DOM. The `./feedback` entry is the only platform-free part.
- `src/presets.ts` must stay in step with `web-haptics`. If you copy it, copy the drift test too.
- Most of `.github/` is release, provenance and evidence tooling (screenshots, planning JSON) specific to this project's npm publishing. It is not worth adopting as a whole.
