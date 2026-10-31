#!/usr/bin/env python3
"""Runs the tests of this folder: python3 test/run_tests.py [file pattern, default test_*.py]. Exits non-zero on any failure.
The tests make their own small videos with ffmpeg, so they need ffmpeg, numpy, opencv-python, Pillow, SciPy and blake3 (the row's get_it commands install them)."""
import os
import sys
import unittest

here = os.path.dirname(os.path.abspath(__file__))
pattern = sys.argv[1] if len(sys.argv) > 1 else 'test_*.py'
result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.discover(here, pattern=pattern, top_level_dir=here))
sys.exit(0 if result.wasSuccessful() else 1)
