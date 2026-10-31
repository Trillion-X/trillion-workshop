"""Test for do-work/predict_viewer_response.py.

Synthetic predictions only: checks the curve, spike and flat-zone contract with
zero model download.
"""

import importlib.util
import sys
from pathlib import Path

import numpy as np

MODULE_PATH = Path(__file__).parent.parent / "do-work" / "predict_viewer_response.py"
spec = importlib.util.spec_from_file_location("predict_viewer_response", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["predict_viewer_response"] = module
spec.loader.exec_module(module)

LEVELS = [0.0, 0.1, 2.0, 0.1, -1.0, -1.0, -1.0, -1.0, 0.2, 1.5, 0.0]


def synthetic_curve():
    preds = np.repeat(np.asarray(LEVELS)[:, None], 4, axis=1)
    starts = [float(t) for t in range(len(LEVELS))]
    return module.response_curve(preds[::-1], starts[::-1])


def test_curve_is_time_ordered_and_z_scored():
    curve = synthetic_curve()
    assert [p["t"] for p in curve] == [float(t) for t in range(len(LEVELS))]
    zs = np.asarray([p["z"] for p in curve])
    assert abs(zs.mean()) < 1e-3
    assert abs(zs.std() - 1.0) < 1e-3


def test_spikes_are_local_maxima_above_threshold_highest_first():
    found = module.spikes(synthetic_curve(), spike_z=1.0)
    assert [s["t"] for s in found] == [2.0, 9.0]


def test_flat_zones_need_the_minimum_length():
    curve = synthetic_curve()
    zones = module.flat_zones(curve, flat_z=-0.5, min_seconds=3)
    assert [(z["start"], z["end"], z["seconds"]) for z in zones] == [(4.0, 8.0, 4.0)]
    assert module.flat_zones(curve, flat_z=-0.5, min_seconds=5) == []


def test_constant_prediction_has_no_spikes_or_flats():
    curve = module.response_curve(np.ones((5, 3)), [0.0, 1.0, 2.0, 3.0, 4.0])
    assert all(p["z"] == 0.0 for p in curve)
    assert module.spikes(curve, spike_z=1.0) == []
    assert module.flat_zones(curve, flat_z=-0.5, min_seconds=1) == []


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"{len(tests)} passed")
