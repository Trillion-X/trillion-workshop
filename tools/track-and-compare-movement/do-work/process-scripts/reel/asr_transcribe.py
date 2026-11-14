#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/reel/asr_transcribe.py
#
# PURPOSE: Reel-factory stages [5]+[6] `asr.transcribe` + `asr.align` — transcribe a clip's audio to
# WORD-LEVEL timed text and emit the canonical `transcript_word_timed.v1` fact. Per R5 FOLD-INTO-PLAN
# delta #2 this fact is DUAL-PURPOSE: (a) the caption source burned onto the reel, AND (b) the SAME
# artifact Facet-1 (AEO) ingests as the YouTube/RAG citation corpus — one ASR write, two readers,
# zero duplicated compute. That is why this stage writes an EEAF-shaped word-timed fact, not only a
# rendered .srt (the .srt is a downstream RENDERING of this fact).
#
# BACKEND IS DATA (L089 / enum-dissolution): R5 names NVIDIA Parakeet-TDT-0.6B-v3 (transcript) +
# WhisperX wav2vec2 forced-aligner (±50ms word timing) as the highest-leverage stack. Those are the
# registered process-descriptor `model` provenance. This script's DEFAULT backend is `faster-whisper`
# (installed here, word timestamps built in) so the stage runs today; --backend selects the engine
# by DATA, never a code fork. Swapping in Parakeet+WhisperX = edit the descriptor row + install, not
# this file's logic.
#
# FAIL-CLOSED: no audio stream, model load failure, or empty transcript -> non-zero exit + reason.
#
# USAGE: asr_transcribe.py --clip CLIP.mp4 --out TRANSCRIPT.json [--srt OUT.srt]
#                          [--backend faster-whisper|parakeet-whisperx] [--model-size base]
from __future__ import annotations
import argparse, json, sys
from pathlib import Path


def log(m): print(f"[asr] {m}", file=sys.stderr, flush=True)


def _srt_time(t: float) -> str:
    h = int(t // 3600); m = int((t % 3600) // 60); s = int(t % 60); ms = int((t - int(t)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _faster_whisper(clip: str, model_size: str):
    from faster_whisper import WhisperModel
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(clip, word_timestamps=True, vad_filter=True)
    words, text_parts = [], []
    for seg in segments:
        text_parts.append(seg.text.strip())
        for w in (seg.words or []):
            words.append({"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3),
                          "confidence": round(getattr(w, "probability", 1.0), 3)})
    return words, " ".join(text_parts).strip(), f"faster-whisper/{model_size}", getattr(info, "language", None)


def main() -> int:
    ap = argparse.ArgumentParser(description="Reel stage asr.transcribe+align: word-timed transcript (dual caption+RAG fact).")
    ap.add_argument("--clip", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--srt", default=None)
    ap.add_argument("--backend", default="faster-whisper", choices=["faster-whisper", "parakeet-whisperx"])
    ap.add_argument("--model-size", default="base")
    a = ap.parse_args()
    if not Path(a.clip).exists():
        log(f"REFUSED: clip missing: {a.clip}"); return 2
    try:
        if a.backend == "faster-whisper":
            words, text, model_prov, lang = _faster_whisper(a.clip, a.model_size)
        else:
            # parakeet-whisperx backend is DATA-selected; requires `pip install nemo_toolkit[asr] whisperx`.
            log("REFUSED: backend 'parakeet-whisperx' not installed (see install commands in task report)"); return 3
    except Exception as e:
        log(f"REFUSED: ASR failed: {e}"); return 1
    if not words and not text:
        log("REFUSED: empty transcript (no speech detected)"); return 1
    fact = {
        "kind": "transcript_word_timed.v1",
        "model": model_prov, "language": lang,
        "text": text, "words": words,
        "dual_use": "caption-source AND Facet-1 AEO/RAG citation corpus (one write, two readers)",
        "provenance": {"confidence": 1.0, "stage": "asr.transcribe+align", "backend": a.backend},
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(fact, open(a.out, "w"), indent=1)
    if a.srt:
        lines = []
        for i, w in enumerate(words, 1):
            lines.append(f"{i}\n{_srt_time(w['start'])} --> {_srt_time(w['end'])}\n{w['word']}\n")
        Path(a.srt).write_text("\n".join(lines))
    log(f"transcript: {len(words)} words, {len(text)} chars ({model_prov}) -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
