# Local face framing

`semanticReframe(file, {start=0, end, aspectW=9, aspectH=16, fillMode,
python='python3', fps=4, alpha=.35, signal, timeoutMs=120000, manualReframe})`
returns `{reframe, support, samples}`. The existing compositor accepts `reframe`
unchanged. `start`/`end` are finite source seconds, with `end > start` required.
The perception owner seeks to the cut and emits times relative to `start`.
`manualReframe` returns a clone immediately without detection; cancellation still
takes precedence. Application owners validate manual edits before rendering.

Runtime dependencies are the existing motion-analysis
`do-work/process-scripts/reel/detect_subject_track.py`, Python, NumPy, OpenCV,
and OpenCV's `haarcascade_frontalface_default.xml`. The async adapter uses the
shared process-session lifetime owner and removes only its own temporary track
file in a finally block. It downloads nothing and does not inherit optional
DNN model settings. Missing runtime/model dependencies fail explicitly.

The supported automatic behavior detects frontal faces and selects the largest
face in each sampled frame. This does not establish person identity continuity.
Undetected samples use disclosed center fallback. `support.semantic_samples`,
`fallback_samples` and `subject_detected` quantify that actual result. Confidence
numbers identify detector tiers, not calibrated probabilities. The pure
`semanticTrackToReframe` boundary rejects motion/brightness samples, nonfinite
or out-of-bounds coordinates and reordered/duplicate timestamps.

Six tests in `read-data/__tests__/semantic-reframe.test.mjs` cover pure mapping,
manual overrides, cancellation, ranges, actual installed OpenCV rejection of a
bright synthetic block and positive detection in a generated clip using the
already-installed public-domain NASA astronaut sample from scikit-image. These
are fixture results, not personal-footage accuracy or product installation proof.

License: the installed Haar XML includes Intel's permissive OpenCV license;
redistribution must preserve the source notice or reproduce the notice in binary
distribution documentation. The astronaut sample's installed scikit-image
documentation identifies it as public domain with no known restrictions. Tests
read that installed sample; this change does not copy or download it.
