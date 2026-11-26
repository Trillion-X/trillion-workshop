"""stroke_variants.py takes its aspects and speeds from comparison-variants.json, the one list of a comparison's shapes
and speeds, and they are the ones the clip library has always been made in."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "do-work" / "stroke_variants.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("stroke_variants", SCRIPT)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


class TheOneList(unittest.TestCase):
    def test_the_aspects_and_speeds_are_the_variants_list(self):
        variants = json.loads((SCRIPT.parent / "comparison-variants.json").read_text())
        self.assertEqual(M.SPEC["aspects"], {f["id"]: [f["width"], f["height"]] for f in variants["formats"]})
        self.assertEqual(M.SPEC["speeds"], [p.get("speed", 1) for p in variants["passes"] if not p.get("still")])

    def test_they_are_the_shapes_and_speeds_the_library_was_made_in(self):
        self.assertEqual(M.SPEC["aspects"], {"9x16": [1080, 1920], "16x9": [1920, 1080]})
        self.assertEqual(M.SPEC["speeds"], [1, 0.5, 0.25, 0.1])
        self.assertEqual([f"{int(sp * 100)}pct" for sp in M.SPEC["speeds"]], ["100pct", "50pct", "25pct", "10pct"])

    def test_another_variants_file_gives_its_own_lists(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "v.json"
            path.write_text(json.dumps({"formats": [{"id": "1x1", "width": 1080, "height": 1080, "layout": "h"}],
                                        "passes": [{"id": "full"}, {"id": "slow", "speed": 0.3}, {"id": "hold", "still": 1}]}))
            self.assertEqual(M.variant_lists(str(path)), {"aspects": {"1x1": [1080, 1080]}, "speeds": [1, 0.3]})


if __name__ == "__main__":
    unittest.main()
