# predict-viewer-response-to-a-video

A script a person's AI runs on the person's own computer. It runs a published brain-response model (TRIBE v2, Meta FAIR) on one video and writes the predicted response of an average viewer for every second: where it spikes and where it goes flat. It is a prediction, not a measured view count or retention: it compares two cuts of one video, never two different videos. The model's weights are licensed for non-commercial use only (CC-BY-NC-4.0).

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:predict-viewer-response-to-a-video`: `on-your-computer`, with the commands that fetch and run it, and what to tell the person about the licence. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/predict_viewer_response.py` | The command: one JSON request on standard input, `curve.json` and `curve.png` in `out_dir`, a last line `{"result": ...}`. The pure readers (`response_curve`, `spikes`, `flat_zones`, `plot`) need only numpy and matplotlib; the model's imports happen inside `run`. |
| `test/test_response_curve.py` | The curve, spikes and flat zones on synthetic predictions (no model, no video). |
| `test/predict-viewer-response.test.mjs` | Runs that file. Skips, saying why, when python3 or numpy is missing. |

## The request

```
{ "video": "path to read; never written", "out_dir": "a new folder",
  "model": "facebook/tribev2", "modalities": ["video", "audio"],
  "device": "mps | cuda | cpu", "spike_z": 1.0, "flat_z": -0.5, "min_flat_seconds": 3,
  "words_tsv": "optional transcript", "mps_memory_fraction": 0.3, "mps_synchronize_after": ["VJEPA2Layer"] }
```

Every field is the person's; the script holds no model name, device or threshold. `text` needs a gated text model the person must have access to.

## What the curve is

The model predicts fMRI responses on about 20,000 cortical points for the average training subject, once per second, already moved back by the five-second blood-flow lag it was trained with, so second `t` describes what is on screen at second `t`. The curve is the mean over all points, then scored against this video's own mean and spread (`z`). A spike is a local maximum at or above `spike_z`; a flat zone is a run of seconds at or below `flat_z` lasting at least `min_flat_seconds`. Upstream writes the extracted audio beside the video, so the video is copied into `out_dir` and only the copy is given to the model; the copy is removed at the end.

Measured on one Apple silicon laptop: the picture encoder takes 128 seconds per four-second window on the processor and needs 45 to 100 GB or more of GPU memory per window in 32-bit floats; `mps_memory_fraction` and `mps_synchronize_after` bound that at a cost in speed. An NVIDIA GPU is the published target.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `response_curve` | `(predictions, starts) => [{t, response, z}]` | Mean response per second, ordered by time, scored over the video. |
| `spikes` | `(curve, spike_z) => [{t, z}]` | Local maxima at or above the threshold, highest first. |
| `flat_zones` | `(curve, flat_z, min_seconds) => [{start, end, seconds, mean_z}]` | Runs of low seconds long enough to count. |

## Overlap with other Workshop tools

None. `tools/media-composition` finds action, silence and beats from the sound and picture themselves; this predicts a viewer's response with a model.

## Dependencies

**Depends on:** Python 3.11+ with `tribev2`, `torch`, `pandas`, `numpy` and `matplotlib`; the model weights in the Hugging Face cache (the first run downloads them). Nothing is sent anywhere.

**Depended on by:** `tool-rows.json` (`tool:predict-viewer-response-to-a-video`), run on the person's computer by their AI.
