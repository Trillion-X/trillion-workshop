"""Source-owned bridge to Trillion's existing strict chosen-voice speaker.

No settings, reference locators or installed application source are copied here.
The existing computer/speak.mjs owner resolves all of them for each request.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import wave

import numpy as np

from ...common import ShowtimeError
from .base import Engine, EngineResult, check_speed

BRIDGE = Path(__file__).resolve().parents[4] / 'speak.mjs'


class TrillionVoiceEngine(Engine):
    name = 'trillion_voice'
    has_timings = False
    speed_range = (1.0, 1.0)
    default_voice = 'chosen'
    default_lang = 'en'

    def voices(self):
        return []  # The source speaker owns discovery; no cached voice catalogue.

    def available(self):
        return (BRIDGE.is_file(), 'Trillion source speaker bridge')

    def model_id(self, spec):
        # Person voice models can change while an id remains. Never reuse audio
        # from this token; the entry point explicitly disables waveform caching.
        return 'trillion-source:' + spec.name

    def synth(self, tokens, spec, speed, lexicon, sentence_pause=0.3, clause_pause=0.12):
        check_speed(self, speed)
        asked = spec.name.partition(':')[2] if spec.name.startswith('trillion_voice:') else spec.name
        if asked in ('', 'chosen', 'default'):
            raise ShowtimeError('Narration requires an exact existing Trillion voice id.')
        parts = []
        for token in tokens:
            said = token.say or (lexicon.say(token.core, spec.lang) if lexicon else None)
            parts.append(token.lead + (said or token.spoken or token.core) + token.trail)
        with tempfile.TemporaryDirectory(prefix='trillion-narration-') as directory:
            out = Path(directory) / 'line.wav'
            result = subprocess.run([os.environ['TRILLION_NARRATION_NODE'], str(BRIDGE)],
                                    input=json.dumps({'text': ' '.join(parts).strip(), 'voice': asked, 'out': str(out),
                                                      'place': os.environ.get('TRILLION_NARRATION_PLACE')}),
                                    capture_output=True, text=True, timeout=900)
            if result.returncode:
                raise ShowtimeError('Trillion source speaker failed: ' + result.stderr.strip()[-400:])
            answer = json.loads(result.stdout.strip().splitlines()[-1])
            if answer.get('voice', {}).get('id') != asked:
                raise ShowtimeError('Trillion source speaker returned a different voice.')
            with wave.open(str(out), 'rb') as audio_file:
                rate, width, channels = audio_file.getframerate(), audio_file.getsampwidth(), audio_file.getnchannels()
                if width != 2:
                    raise ShowtimeError('Source speaker must return 16-bit PCM.')
                audio = np.frombuffer(audio_file.readframes(audio_file.getnframes()), dtype='<i2').astype(np.float32) / 32768
                if channels > 1:
                    audio = audio.reshape(-1, channels).mean(axis=1)
        if not audio.size:
            raise ShowtimeError('Source speaker returned empty audio.')
        return EngineResult(audio=audio, sample_rate=rate, words=None,
                            meta={'voice': asked, 'engine': answer['engine'], 'source_speaker': str(BRIDGE)})


ENGINE = TrillionVoiceEngine()
