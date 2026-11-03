"""Synthetic videos and a stand-in picture model for the tests of do-work/make_picture_vector_set.py. No one's footage.

  synthetic_picture_set.py videos FOLDER [NAME:COLOUR:SECONDS ...]   solid-colour videos with a key frame every half second
  synthetic_picture_set.py build VIDEOS OUT [--proxy PATTERN]         the builder with the stand-in model; prints its result

The stand-in model's vector of a frame is its mean red, green and blue, so a red frame is closest to [1, 0, 0].
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work"))
import make_picture_vector_set as builder  # noqa: E402


def mean_colour(rgbs):
    return [rgb.reshape(-1, 3).mean(axis=0) + 1e-3 for rgb in rgbs]


if sys.argv[1] == "videos":
    folder = sys.argv[2]
    os.makedirs(folder, exist_ok=True)
    for spec in sys.argv[3:]:
        name, colour, seconds = spec.split(":")
        os.makedirs(os.path.dirname(os.path.join(folder, name)) or folder, exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={colour}:s=320x180:r=24:d={seconds}",
                        "-g", "12", "-pix_fmt", "yuv420p", os.path.join(folder, name)], check=True)
else:
    videos, out = sys.argv[2], sys.argv[3]
    proxy = sys.argv[sys.argv.index("--proxy") + 1] if "--proxy" in sys.argv else None
    result = builder.build(videos, out, mean_colour, every=2.0, proxy=proxy, pattern="*.mp4", model="stand-in mean colour", log=lambda line: None)
    print(json.dumps({"result": result}))
