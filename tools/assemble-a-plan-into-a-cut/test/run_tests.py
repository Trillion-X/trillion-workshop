"""Run every test in test_assemble.py and print one JSON line: {"ok", "ran", "failures": [...]}. Exit 0 only when all pass."""
import io
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

suite = unittest.defaultTestLoader.loadTestsFromName('test_assemble')
stream = io.StringIO()
result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
sys.stderr.write(stream.getvalue())
failures = [{'test': str(t), 'trace': tb.strip().splitlines()[-6:]} for t, tb in result.failures + result.errors]
print(json.dumps({'ok': result.wasSuccessful(), 'ran': result.testsRun, 'failures': failures}))
sys.exit(0 if result.wasSuccessful() else 1)
