#!/usr/bin/env python3
"""Prints one JSON line {ok, reason}: whether this machine has what the tests need (ffmpeg, numpy, OpenCV, Pillow, SciPy, blake3)."""
import importlib.util
import json
import shutil

missing = [name for name in ('numpy', 'cv2', 'PIL', 'scipy', 'blake3') if importlib.util.find_spec(name) is None]
missing += [tool for tool in ('ffmpeg', 'ffprobe') if shutil.which(tool) is None]
print(json.dumps({'ok': not missing, 'reason': 'missing ' + ', '.join(missing) if missing else ''}))
