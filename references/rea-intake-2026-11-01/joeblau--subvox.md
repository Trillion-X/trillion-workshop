# joeblau/subvox

- Source: https://github.com/joeblau/subvox @ 591d02838521c3d33107bc9fde1a6fd620f96d58 (2026-10-30)
- Licence: MIT, in `LICENSE` (copyright held by the repository owner; the notice travels with any copied code). No package manifest with a licence field (it is an XcodeGen `project.yml` app) and no vendored code. Code may be copied into an Apache-2.0/MIT project, keeping the MIT notice.

## What it does

A macOS 14+ SwiftUI prototype that tests whether AirPods head-motion data (`CMHeadphoneMotionManager`, roughly 25 Hz) carries enough signal to recognise silently mouthed words. The user records templates per word (hold Space, mouth the word); new segments are matched to templates by nearest-neighbour dynamic time warping and accepted only if distance and margin pass thresholds. An "Evaluate" step runs leave-one-out classification plus a 500-shuffle label-permutation test, reporting accuracy vs chance, a p-value and a confusion matrix. Alongside, Apple's `SFSpeechRecognizer` transcribes the microphone continuously as a reference, and a session recorder writes motion CSV, audio, events and clock offsets for experiments.

## How it is built

- XcodeGen project (`project.yml`): one macOS app target `Subvox` and one XCTest target `SubvoxTests`. Swift 5, no third-party packages; Apple frameworks only (CoreMotion, AVFoundation, Speech, CoreAudio, SwiftUI, Observation).
- `Subvox/Motion/`: `HeadphoneMotionService.swift` (motion updates, connection state, measured sample rate over a 1 s window), `MotionSample.swift` (sample struct, CSV row).
- `Subvox/Decoding/`: `CaptureController.swift` (segmentation), `MotionFeatures.swift` (energy, trim, per-frame features, channel scaling), `DTW.swift` (banded DTW), `TemplateClassifier.swift` (classifier, `Prediction`, and `Evaluation` with LOO and permutation test), `TemplateStore.swift` (JSON dataset in Application Support).
- `Subvox/Audio/`: `AudioService.swift` (AVAudioEngine input tap, device switching, `AudioSink` fan-out, RMS level meter), `AudioDevices.swift`, `MicTranscriber.swift` (continuous on-device speech recognition).
- `Subvox/Recording/SessionRecorder.swift`: writes `motion.csv`, `audio.caf`, `events.csv`, `meta.json` per session.
- `Subvox/Views/`, `Subvox/App/`: SwiftUI screens (Sensors, Train, Decode) and app model.
- Tests: `SubvoxTests/DecodingTests.swift`, four XCTest cases on synthetic motion (sine bursts on one rotation axis): DTW is zero for identical and tolerant of stretching, classifier separates distinct words, evaluation beats chance only when signal exists, trim drops quiet padding.

## Reusable techniques worth learning

1. **Energy-triggered segmentation with calibrated noise floor, pre-roll and hangover** — `Decoding/CaptureController.swift`. A smoothed energy (`0.6*old + 0.4*new`) is compared against `median(energy over a 2 s calibration) * triggerRatio` (default 3). Capture starts with the last 0.3 s of pre-roll already in the buffer, ends after 0.35 s below 70% of the threshold (hysteresis), and has a hard maximum length; segments shorter than 4 samples or 0.15 s are dropped. A compact, general voice/activity-detection pattern.
2. **Segment-relative trimming** — `Decoding/MotionFeatures.swift` `trim`. Within a segment, floor = 20th-percentile energy, peak = max; frames above `floor + 0.15*(peak - floor)` mark the active region, padded by 2 frames; it does nothing if peak is not at least 1.5x floor or the result would be under 5 frames. Because the threshold is relative to the segment, training and decoding trim the same way.
3. **Banded, length-normalised DTW** — `Decoding/DTW.swift`. Two-row DP with a Sakoe–Chiba band of `max(|n-m|, 0.25*max(n,m))`, and the final cost divided by `n + m` so long and short sequences compare fairly. About 30 lines; O(n·band) memory O(m).
4. **Nearest-neighbour with rejection by absolute distance and relative margin** — `TemplateClassifier.swift` `predict`, `margin`. Confidence is `1 - d1/d2` (best vs runner-up class); a prediction is accepted only if `d1 <= maxDistance` and confidence `>= minConfidence`. A cheap open-set rejection rule for any template matcher.
5. **Leave-one-out + label-permutation test on a precomputed distance matrix** — `TemplateClassifier.swift` `Evaluation.run`. All pairwise DTW distances are computed once; LOO accuracy is computed for the true labels and for 500 shuffled labelings reusing the same matrix; p = `(count(null >= observed) + 1) / (permutations + 1)`. Also reports chance as majority-class rate and the null 95th percentile. A clean, honest "is the signal real?" test that costs almost nothing extra.
6. **Per-channel mean-centring and corpus z-scaling** — `MotionFeatures.swift` `frames`, `channelScales`, `scaled`. Each channel is mean-centred per segment (removes posture bias); angles are taken relative to the first frame and wrapped with `atan2(sin, cos)`; then each channel is divided by its std across the training corpus so no channel dominates the distance.
7. **Restarting a continuous recogniser with a generation counter** — `Audio/MicTranscriber.swift`. Apple's recognition tasks end on silence/timeout; on final or error the code appends the text to a finalised prefix and starts a fresh task after 50 ms (500 ms after error). A `generation` integer makes callbacks from older tasks no-ops. A thread-safe `RequestBox` swaps the active request under a lock while the audio thread appends buffers.
8. **Clock alignment between audio and sensor streams** — `Recording/SessionRecorder.swift`. Motion times are stored relative to a session start in system uptime; the first audio buffer's host time is converted to seconds and written to `meta.json` as `audioStartOffsetSeconds`, with a note explaining the reference clock. Simple and makes later alignment exact.

## Fit with trillion-workshop tools

- `tools/track-and-compare-movement` (`do-work/align_dtw.py`): technique 3 fits directly. `_dtw` fills a full `(T1+1) x (T2+1)` matrix with no band and the output (`phase_alignment.v1`) reports only the path, not how well the two movements matched. Small change: return the final cost and write `"distance": R[T1, T2] / (T1 + T2)` (length-normalised, as Subvox does) in the output and result line, and optionally accept `--band FRACTION` that restricts `j` to `|i - j*T1/T2| <= band` (Subvox uses `max(|n-m|, 0.25*max(n,m))` on raw indices). Testable in `test/test_align_dtw.py`: identical tracks give distance 0; a different movement gives a larger distance than a time-stretched copy of the same one; a band of 1.0 gives the same path as no band. Note the README says the aligner "does not say which movement is better"; a distance is a similarity number, not a verdict, so it fits that rule.
- `tools/grade-and-repair-speech-audio` (`read-data/measure.py`): already reads noise floor from word gaps or the quietest 10% of frames, similar to technique 1/2. No change needed.
- `tools/listen-for-a-while` / `tools/audio-transcription`: technique 1 (energy trigger with pre-roll and hangover) could in principle cut pieces at silences instead of fixed lengths, but `listen-for-a-while` uses an ffmpeg recorder writing pieces back to back and whisper.cpp, so this would be a larger change, not a small one. Technique 7 is specific to Apple's `SFSpeechRecognizer`; none.
- Technique 5 (permutation test) has no current consumer; it would suit any tool that claims a classifier or measure separates groups (`run-experiments` might, but it was not checked here).

## Cautions

- A research prototype (single commit, version 0.1.0), not a library. Thresholds (trigger ratio 3, 0.15 trim fraction, 5x weight of acceleration in energy, band 0.25) are tuned by hand for AirPods motion at ~25 Hz.
- `project.yml` hard-codes a `DEVELOPMENT_TEAM` id and disables hardened runtime; irrelevant for copying techniques, but do not reuse the project file.
- The README's claims about whether the signal works were not verified; nothing was built or run.
- DTW is O(n·m) in Swift with no vectorisation; fine for short segments, not for long recordings.
