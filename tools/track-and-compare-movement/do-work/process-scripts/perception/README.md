# motion-analysis perception bundle

Purpose: Run the crown-jewel perception bundle from clip to `motion-clip-descriptor.v1` in two stages, `pose_estimate` then `describe_clip`, through `run_perception.py`.

## Files

| File | Purpose |
|------|---------|
| `body_orientation.py` | JointBDOE-backed body-heading estimator used by descriptor windows for heading degrees. |
| `describe_clip.py` | Stage 2 descriptor builder: pose track plus source clip to windowed `motion-clip-descriptor.v1`. |
| `finite_json.py` | Finite JSON waist that sanitizes or rejects non-finite numeric JSON values. |
| `model_location.py` | Finds an onnx model at run time: `$MATCH_VENDOR_ROOT` (host DATA), then beside the scripts, then the build-time `onnx/` folder. The models are never tracked here, not even as links. |
| `orchestrate.sh` | Positional process-engine adapter: `<clip> <cwd> <label> <requestId> [checkpoint]` to `run_perception.py`, writing `command-output.json`. |
| `orientation.py` | CLIP/open-clip camera-facing and elevation helpers used by descriptor enrichment. |
| `pose_estimate.py` | Stage 1 YOLO-pose estimator: video to cached pose JSON. |
| `pose_schema.py` | COCO-17 names, mirror maps, comparison spec shapes, and pose-track canonicalization helpers. |
| `run_perception.py` | Single process-job entrypoint chaining pose estimation and descriptor generation. |
| `swing_state.py` | Data-driven swing-state channel extraction and comparison helpers for descriptor evidence. |
| `test_bundle_parity.py` | Drift guard that checks bundled files match the source SSOT and rejects stray `.py` files. |

## Key Types/Functions

| Symbol | Signature / Shape | Role |
|--------|-------------------|------|
| `run_perception.run_perception(clip, out, kp=None, salience_config=None, device=None, checkpoint=None, max_frames=None)` | `Path, Path, Path | None, str | None, str | None, str | None, int | None -> int` | Thin two-stage process-job wrapper; returns nonzero for missing clip, failed pose, or failed describe stage. |
| `run_perception.main()` | CLI: `--clip --out [--kp --salience-config --device --checkpoint --max-frames]` | Public entrypoint used by `orchestrate.sh` and process-engine descriptors. |
| `orchestrate.sh` | `bash orchestrate.sh <clip> <cwd> <label> <requestId> [checkpoint]` | Adapts the motion-analysis tracker positional contract and writes `<cwd>/command-output.json`. |
| `pose_estimate.main()` | CLI: `--video --out [--checkpoint --device --conf --max-frames --no-cache]` | Produces pose JSON from the clip using the runtime YOLO pose model. |
| `describe_clip.describe(kp, source, salience_cfg=DEFAULT_SALIENCE_CONFIG)` | `dict, str, SalienceConfig -> dict` | Builds the descriptor object from pose data and source media. |
| `describe_clip.detect_windows(person, fps, cfg=DEFAULT_SALIENCE_CONFIG)` | `person, fps, SalienceConfig -> list[tuple[int, int]]` | Finds motion windows from the configured salience signal. |
| `describe_clip.SalienceConfig` | dataclass with salience keypoints, reducer, normalization, and windowing thresholds | Data seam for domain-specific motion segmentation. |
| `test_bundle_parity.main()` | `-> int` | Bundle-parity drift guard for source-vs-package byte identity. |

## Dependencies

Depends on: `torch`, `ultralytics`/YOLO, `cv2`, `PIL`, `open_clip`, and `JOINTBDOE_VENDOR` at runtime in the `compute.process` environment.

Depended on by: motion-analysis submit workflow actions and motion-analysis ingest-reference actions.
