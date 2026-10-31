"""Runs the Python tests of one test file: every unittest TestCase, and every
module-level `test_*` function (the plain-assert style the carried tests use).
Prints one line per test and exits non-zero when any fails.

  python3 run_tests.py test_transcript_mapper.py
"""
import importlib.util
import inspect
import pathlib
import sys
import traceback
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main(name):
    spec = importlib.util.spec_from_file_location(pathlib.Path(name).stem, HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    passed, failed = 0, 0
    for attr, fn in sorted(vars(module).items()):
        if attr.startswith("test_") and inspect.isfunction(fn) and fn.__module__ == module.__name__:
            try:
                fn()
                passed += 1
                print(f"pass {attr}")
            except Exception:  # noqa: BLE001  (a failing test is reported, never fatal)
                failed += 1
                print(f"FAIL {attr}\n{traceback.format_exc()}")
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    if suite.countTestCases():
        result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(suite)
        failed += len(result.failures) + len(result.errors)
        passed += result.testsRun - len(result.failures) - len(result.errors)
    print(f"python tests {name}: {passed} passed, {failed} failed")
    return 1 if failed or not passed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
