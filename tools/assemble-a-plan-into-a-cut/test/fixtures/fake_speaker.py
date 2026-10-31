"""A stand-in speaker for the tests: a tone as long as the line (0.08 s a character, at least 0.5 s), and its word times.

usage: python3 fake_speaker.py <line.txt> <take.wav>

Writes take.wav (mono 48 kHz) and take.words.json, each word timed evenly over the tone.
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

text = Path(sys.argv[1]).read_text()
out = Path(sys.argv[2])
sr, dur = 48000, max(0.5, 0.08 * len(text))
t = np.arange(int(sr * dur)) / sr
sf.write(out, (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), sr, subtype='PCM_24')
words = text.split()
step = dur / max(1, len(words))
out.with_suffix('.words.json').write_text(json.dumps({'words': [{'text': w, 'start': round(k * step, 3), 'end': round((k + 0.8) * step, 3)}
                                                                for k, w in enumerate(words)]}))
