"""Writes a made-up generated voice take and its word files into the folder given: voice_take_fixture.py <folder>.

  take.wav        synthetic speech (see synthetic_speech.py) over a -70 dBFS hiss, with a click inside "charlie" at
                  2.65 s and a 2 ms tick in the pause at 1.95 s
  take.words.json the words as a whisper read gives them: each start 0.15 s early, inside the pause before the word
  line.json       the script the take was made from, spelled differently from the read ("Alfa")
  refs/ref.wav    a reference recording (the clean synthetic speech)
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synthetic_speech  # noqa: E402

folder = Path(sys.argv[1])
(folder / "refs").mkdir(parents=True, exist_ok=True)
sr = synthetic_speech.SR
x, words = synthetic_speech.speech(noise_db=-70.0)
x[int(2.65 * sr):int(2.65 * sr) + 4] = -0.95
x[int(1.95 * sr):int(1.952 * sr)] += 0.02
sf.write(folder / "take.wav", x, sr, subtype="PCM_24")
clean, _ = synthetic_speech.speech(noise_db=-80.0, seed=3)
sf.write(folder / "refs" / "ref.wav", clean, sr, subtype="PCM_24")
read = [{"text": w["text"], "start": round(w["start"] - 0.15, 3), "end": w["end"]} for w in words]
(folder / "take.words.json").write_text(json.dumps({"words": read}, indent=1))
(folder / "line.json").write_text(json.dumps({"script": "Alfa bravo charlie delta echo"}))
