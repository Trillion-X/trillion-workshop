"""Writes three synthetic recordings and spans.json into the folder given: build_fixture.py <folder>.

  clean.wav   a quiet floor: grades good
  noisy.wav   a loud floor and a 60 Hz hum: grades remaster
  clipped.wav the same voice driven into clipping: grades remaster
spans.json lists one span of each (with word times) and a repeat of the first, which is graded once.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synthetic_speech  # noqa: E402

folder = Path(sys.argv[1])
folder.mkdir(parents=True, exist_ok=True)
kinds = {
    "clean": dict(noise_db=-80.0),
    "noisy": dict(noise_db=-38.0, hum_db=-30.0),
    "clipped": dict(noise_db=-80.0, clip=True),
}
spans = []
for name, options in kinds.items():
    words = synthetic_speech.write(folder / f"{name}.wav", **options)
    spans.append({"clip": name, "source": str(folder / f"{name}.wav"), "from": 0.4, "to": 5.0,
                  "text": " ".join(w["text"] for w in words), "words": words})
spans.append(dict(spans[0]))
(folder / "spans.json").write_text(json.dumps({"spans": spans}, indent=1))
