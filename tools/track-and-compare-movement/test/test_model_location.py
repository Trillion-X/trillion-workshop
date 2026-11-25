"""Every perception model and asset is found through model_location: the folder named by MATCH_VENDOR_ROOT first.
clip_axes.npz (the camera-facing and elevation axes) was looked for only beside orientation_onnx.py, so a host that
gave its models as data got heading but no elevation ("orientation_onnx asset missing", Nov 25 2026)."""
import os
import subprocess
import sys
import tempfile
import unittest

PERCEPTION = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work", "process-scripts", "perception")


class AssetsComeFromTheModelFolder(unittest.TestCase):
    def test_clip_axes_is_read_from_match_vendor_root(self):
        with tempfile.TemporaryDirectory() as vendor:
            axes = os.path.join(vendor, "clip_axes.npz")
            open(axes, "wb").close()
            env = {**os.environ, "MATCH_VENDOR_ROOT": vendor}
            code = "import orientation_onnx as o; print(o.DEFAULT_CLIP_AXES)"
            r = subprocess.run([sys.executable, "-c", code], cwd=PERCEPTION, env=env, capture_output=True, text=True)
            if r.returncode and "No module named" in r.stderr:
                self.skipTest(r.stderr.strip().splitlines()[-1])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(os.path.realpath(r.stdout.strip()), os.path.realpath(axes))


if __name__ == "__main__":
    unittest.main()
