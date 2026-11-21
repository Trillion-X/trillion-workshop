"""The module map is DATA the worker reads: it must name a repo, a cap, and the mapping rule the worker applies."""
import json
import os
import py_compile
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))


class ModuleMap(unittest.TestCase):
    def test_map_names_every_key_the_worker_reads(self):
        data = json.load(open(os.path.join(HERE, "..", "read-data", "module-map.json")))
        for key in ("repo", "source_root", "drop_last_segments", "test_root", "skip_paths", "cargo_target", "cap_seconds", "jobs"):
            self.assertIn(key, data)
        self.assertGreater(data["cap_seconds"], 0)

    def test_worker_compiles(self):
        py_compile.compile(os.path.join(HERE, "..", "do-work", "run_the_tests.py"), doraise=True)


if __name__ == "__main__":
    unittest.main()
