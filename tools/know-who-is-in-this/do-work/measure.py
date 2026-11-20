"""The measuring the three know-who-is-in-this scripts share: a voice vector for a stretch of a recording and a face
vector for a face in a picture. The CAM++ voice model and the YuNet and SFace face models are the ones
tools/media-composition already holds (find-recurring-voices.py, blur-faces-not-agreed.py); this file loads those
scripts and calls them, so the models and their preparation exist once. The container mounts media-composition's
do-work folder beside this tool's folder (the same two levels up that audio-transcription is found by); MEDIA_COMPOSITION_WORK
names another place for running by hand.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np
from PIL import Image

WORK = os.environ.get("MEDIA_COMPOSITION_WORK", os.path.join(os.path.dirname(__file__), "..", "..", "media-composition", "do-work"))
RATE = 16000


def module(file: str, name: str, folder: str = WORK):
    spec = importlib.util.spec_from_file_location(name, os.path.join(folder, file))
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


def voices():
    return module("find-recurring-voices.py", "find_recurring_voices")


def faces():
    return module("blur-faces-not-agreed.py", "blur_faces_not_agreed")


def transcript_segments(path: str, seconds: int) -> list[dict]:
    """Hear the bounded recording through audio-transcription's existing Whisper chooser.

    Engine/model failures remain failures. The temporary WAV is removed on every outcome; no transcript or timing
    is invented here. Inference runs here, while the selected provider may fetch its public model weights.
    """
    folder = os.environ.get("AUDIO_TRANSCRIPTION_WORK", os.path.join(os.path.dirname(__file__), "..", "..", "audio-transcription", "do-work"))
    transcriber = module("whisper_here.py", "speaker_audio_transcription", folder)
    audio = voices().audio_from(path, seconds)
    with tempfile.TemporaryDirectory(prefix="speaker-transcript-") as temporary:
        recording = os.path.join(temporary, "recording.wav")
        with wave.open(recording, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(RATE)
            output.writeframes(audio.astype("<i2").tobytes())
        heard = transcriber.transcribe(recording, word_timestamps=True)
    if not isinstance(heard, dict) or not isinstance(heard.get("segments"), list):
        raise ValueError("The transcription engine did not return timed segments.")
    return heard["segments"]


def voice_vectors(path: str, spans: list[dict], seconds: int, model_path: str | None = None) -> list[list[float] | None]:
    """One 192-number vector per span (None when the span is too short to measure), from the recording at `path`."""
    import onnxruntime as ort
    heard = voices()
    session = ort.InferenceSession(model_path or heard.MODEL, providers=["CPUExecutionProvider"])
    audio = heard.audio_from(path, seconds)
    out = []
    for span in spans:
        piece = audio[int(float(span["start"]) * RATE):int(float(span["end"]) * RATE)]
        vector = heard.embed(session, piece.astype(np.float32) / 32768.0) if len(piece) else None
        out.append(None if vector is None else vector.tolist())
    return out


def speech_vectors(path: str, seconds: int, model_path: str | None = None) -> list[list[float]]:
    """One vector per window of speech (the voice activity windows find-recurring-voices uses) in a recording that holds
    one person talking, for enrolling that voice."""
    import onnxruntime as ort
    heard = voices()
    session = ort.InferenceSession(model_path or heard.MODEL, providers=["CPUExecutionProvider"])
    audio = heard.audio_from(path, seconds)
    vectors = (heard.embed(session, audio[first:last].astype(np.float32) / 32768.0) for first, last in heard.speech_windows(audio))
    return [vector.tolist() for vector in vectors if vector is not None]


def face_finder(models: dict | None = None):
    """The detector and recognizer, loaded once: finder.find(rgb) and finder.print_of(rgb, face)."""
    blur = faces()
    paths = {**blur.MODELS, **(models or {})}
    return blur.Faces(paths["detector"], paths["recognizer"])


def picture(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"))


def video_pictures(path: str, every_seconds: float):
    """(second, RGB picture) every `every_seconds` of a video, read with ffmpeg."""
    blur = faces()
    width, height, _, _ = blur.probe(path)
    size = width * height * 3
    reader = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", f"fps=1/{every_seconds}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                              stdout=subprocess.PIPE)
    at = 0
    while True:
        raw = reader.stdout.read(size)
        if len(raw) < size:
            break
        yield at * every_seconds, np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3)
        at += 1
    reader.wait()


def is_picture(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in {".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
