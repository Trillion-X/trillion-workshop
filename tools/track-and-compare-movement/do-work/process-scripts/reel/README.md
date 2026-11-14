# reel/ — Reel-Factory Perception Process-Jobs (DATA-dispatched, generic)

Stage scripts for the auto-generated side-by-side technique-comparison reel. Each is a blind transform (files in → artifact out) invoked as a `process-descriptor-config` DATA row (`package::motion-analysis::process-descriptor-config::reel-*`) dispatched by `compute.process` / `OsProcessBackend` (`architect/crates/process-engine`). No script schedules, watches the filesystem, or names a sport — swap the input DATA (basketball, golf, any movement) and the chain works unchanged (deletion test PASSES). NO new package; these live in the generic perception owner `motion-analysis`.

## Files

| File | R5 stage | Purpose |
|------|----------|---------|
| `track_ball.py` | [1] `vision.ball.track` | Ball track + contact/bounce events (TrackNetV4). Fail-closed if weights absent; live `ball-court` WASB-SBDT descriptor is the fallback. |
| `align_dtw.py` | [3] `align.dtw` | Phase-align two `pose.keypoints.v1` tracks via soft-DTW over hip-centered torso-scaled COCO-17 features. Zero-dep numpy (tslearn/dtaidistance-equivalent). |
| `render_side_by_side.py` | [4] `render.skeleton_overlay` | Deterministic opencv/ffmpeg side-by-side (student left, reference right) with skeleton overlays, driven by the DTW alignment. |
| `asr_transcribe.py` | [5]+[6] `asr.transcribe`+`asr.align` | Word-timed transcript (`transcript_word_timed.v1`). DUAL-USE: caption source AND Facet-1 AEO/RAG citation corpus. Default backend faster-whisper; Parakeet-TDT→WhisperX by DATA. |
| `voice_synthesize.py` | [8] `voice.synthesize` | Coach-script → voiceover.wav (Resemble Chatterbox, MIT, $0/render). Fail-closed if uninstalled; MiniMax substituted by DATA on language mismatch. |
| `render_vertical_crop.py` | [9] `render.vertical_crop_publish` | Final 9:16 (1080x1920) reframe + caption burn-in + VO mux → dispatch to Blotato (T4). |

Pose [2] and clip-saliency [7] reuse existing owners: pose = `perception/run_perception.py` (YOLO11x-pose, tier-selected by `pose_model_strategy` DATA); saliency = `formula-engine` reduction over facts this pipeline already emits (no new perception model).

## Key contracts

- **Input pose format:** `pose.keypoints.v1` — `persons[].frames[]`, each frame `{t, i, kp:[[x,y,conf]×17 COCO-17]}`.
- **Fail-closed (SP5):** every stage exits non-zero with a machine-readable reason on missing input / model / degenerate data; never a silent wrong artifact.
- **Provenance:** every output fact carries `model` + `provenance.confidence`.

## Dependencies

**Depends on:** `perception/run_perception.py` + `pose_estimate.py` (pose), `numpy`/`opencv-python` (align+render), `faster-whisper` (ASR default), `ffmpeg` (encode/crop/caption), and — when installed — TrackNetV4, RTMPose/HRNet, NeMo Parakeet + WhisperX, `chatterbox-tts`.
**Depended on by:** the reel-factory `workflow-definition` chaining the eight `reel-*` process-descriptor-config rows; downstream `content-distribution` (Blotato) publish.
