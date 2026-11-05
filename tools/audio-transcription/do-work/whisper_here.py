"""Speech to text with word times on whatever this place has: a second option for the Apple-only mlx_whisper.

Drop-in for `mlx_whisper.transcribe(path, path_or_hf_repo=..., **options)`; returns the same shape
({"text", "language", "segments": [{"id", "start", "end", "text", "words": [{"word", "start", "end", "probability"}]}]}).

Which engine runs is what the place has (docs/decouple-sweep.md, "Apple-only capabilities"):
  WHISPER_BACKEND=mlx|faster|openai picks one; otherwise the first that imports, in that order:
  - mlx       mlx_whisper (Apple silicon only), the engine the films' numbers were measured with;
  - faster    faster-whisper (CTranslate2: cuda or cpu), same Whisper weights converted;
  - openai    openai-whisper (torch: cuda, mps or cpu).
The model name is mapped: mlx-community/whisper-large-v3-turbo -> large-v3-turbo, and so on. Word times from another engine
are close but not byte-identical to mlx_whisper's; a result says which engine made it in result["engine"].
"""
import importlib.util
import os
import re

ENGINES = ("mlx", "faster", "openai")
MODULE = {"mlx": "mlx_whisper", "faster": "faster_whisper", "openai": "whisper"}
PASSED = ("language", "word_timestamps", "condition_on_previous_text", "initial_prompt", "temperature",
          "no_speech_threshold", "compression_ratio_threshold")


def engine():
    asked = os.environ.get("WHISPER_BACKEND")
    if asked:
        if asked not in ENGINES:
            raise SystemExit(f"WHISPER_BACKEND={asked}: use one of {', '.join(ENGINES)}")
        return asked
    for name in ENGINES:
        if importlib.util.find_spec(MODULE[name]) is not None:
            return name
    raise SystemExit("This place has no speech-to-text engine: install mlx-whisper (Apple), faster-whisper or openai-whisper")


def model_name(repo):
    """'mlx-community/whisper-large-v3-turbo' -> 'large-v3-turbo' (the name faster-whisper and openai-whisper use)."""
    base = repo.rsplit("/", 1)[-1]
    base = re.sub(r"^whisper-", "", base)
    return re.sub(r"-(mlx|4bit|8bit|q4|fp16)$", "", base)


def transcribe(audio, path_or_hf_repo="mlx-community/whisper-large-v3-turbo", **options):
    options.pop("verbose", None)
    kind = engine()
    if kind == "mlx":
        import mlx_whisper
        result = mlx_whisper.transcribe(audio, path_or_hf_repo=path_or_hf_repo, **options)
        result["engine"] = "mlx_whisper"
        return result
    opts = {k: v for k, v in options.items() if k in PASSED}
    if kind == "openai":
        import whisper
        result = whisper.load_model(model_name(path_or_hf_repo)).transcribe(str(audio), **opts)
        result["engine"] = "openai-whisper"
        return result
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name(path_or_hf_repo), device=os.environ.get("WHISPER_DEVICE", "auto"), compute_type="default")
    if isinstance(opts.get("temperature"), tuple):
        opts["temperature"] = list(opts["temperature"])
    segs, info = model.transcribe(str(audio), **opts)
    segments = []
    for i, s in enumerate(segs):
        words = [{"word": w.word, "start": w.start, "end": w.end, "probability": w.probability} for w in (s.words or [])]
        segments.append({"id": i, "seek": s.seek, "start": s.start, "end": s.end, "text": s.text, "tokens": list(s.tokens),
                         "temperature": s.temperature, "avg_logprob": s.avg_logprob, "compression_ratio": s.compression_ratio,
                         "no_speech_prob": s.no_speech_prob, **({"words": words} if opts.get("word_timestamps") else {})})
    return {"text": "".join(s["text"] for s in segments), "segments": segments, "language": info.language, "engine": "faster-whisper"}
