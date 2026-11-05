sentences in Kokoro bm_lewis, ending on a sentence end), so the timbre stays and only the model's rhythm and
intonation change.

Same line data, units, pauses and inner-pause ceiling as kokoro_take.py. Each unit is made N times (best of N); the take kept is
the one whose mlx-whisper transcript has the fewest word errors against the unit's words, then the one whose length is
nearest the median of the N (an outlier length is a rushed or dragged take). Speech is never stretched.
Engines (all run by mlx-audio 0.5.8 with python3):
  qwen3       mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16 (Apache-2.0), reference audio + its exact words
  chatterbox  mlx-community/synthetic-b198f86bcd39-8bit (Resemble Chatterbox Turbo, MIT), reference audio
  pocket      mlx-community/pocket-tts (Kyutai Pocket TTS, CC-BY-4.0), reference audio
"""
import argparse
import json
import re
import sys
from pathlib import Path
import numpy as np
import soundfile as sf
import sys, pathlib; sys.path.insert(0, str(next(p for p in pathlib.Path(__file__).resolve().parents if (p / 'capabilities.json').is_file()) / 'tools/place-capabilities')); import whisper_here as mlx_whisper  # mlx_whisper where the place has it, else faster-whisper or openai-whisper
from mlx_audio.tts.utils import load_model

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import kokoro_take as kt  # noqa: E402  (read_line, join: one definition of units, pauses and silence handling)

