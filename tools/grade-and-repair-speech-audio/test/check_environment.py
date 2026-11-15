"""Prints {"ok": true} when this computer can run the grading stage (numpy, scipy, soundfile, ffmpeg), else {"ok": false, "reason": ...}."""
import importlib
import json
import shutil
import sys


def check():
    try:
        for module in ("numpy", "scipy", "soundfile") + (("librosa",) if "--pitch" in sys.argv[1:] else ()):
            importlib.import_module(module)
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg is not on PATH")
    except Exception as error:  # noqa: BLE001 (any failure means "cannot run here", with its reason)
        return {"ok": False, "reason": f"{type(error).__name__}: {error}"}
    return {"ok": True}


print(json.dumps(check()))
