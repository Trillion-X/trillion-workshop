#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/reel/voice_synthesize.py
#
# PURPOSE: Reel-factory stage [8] `voice.synthesize` — turn a coach script (text) into a voiceover
# .wav in the coach's cloned voice. R5 default: Resemble Chatterbox (MIT, self-hosted, 350M params,
# sub-200ms, $0/render — the only voice option whose unit economics survive hundreds of reels/day).
#
# BACKEND IS DATA (L089): `voice_synthesis_backend` DATA row picks chatterbox (default) vs MiniMax
# Speech (multilingual Fluent-LoRA, auto-substituted when target_language != source_clone_language).
# FAIL-CLOSED per SP5: if Chatterbox is not installed this exits non-zero with the exact install
# command; it NEVER emits silent/empty audio.
#
# USAGE: voice_synthesize.py --text-file SCRIPT.txt --out VO.wav [--voice-ref REF.wav] [--exaggeration 0.5]
from __future__ import annotations
import argparse, sys
from pathlib import Path

INSTALL = "pip install chatterbox-tts   # Resemble Chatterbox (MIT); first run downloads the 350M model"


def log(m): print(f"[voice.synthesize] {m}", file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Reel stage voice.synthesize (Resemble Chatterbox).")
    ap.add_argument("--text-file", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--voice-ref", default=None); ap.add_argument("--exaggeration", type=float, default=0.5)
    a = ap.parse_args()
    if not Path(a.text_file).exists():
        log(f"REFUSED: script missing: {a.text_file}"); return 2
    text = Path(a.text_file).read_text().strip()
    if not text:
        log("REFUSED: empty script"); return 2
    try:
        import torchaudio
        from chatterbox.tts import ChatterboxTTS
    except Exception:
        log("REFUSED: Chatterbox not installed."); log(f"INSTALL: {INSTALL}"); return 3
    try:
        model = ChatterboxTTS.from_pretrained(device="cpu")
        wav = model.generate(text, audio_prompt_path=a.voice_ref, exaggeration=a.exaggeration) \
            if a.voice_ref else model.generate(text, exaggeration=a.exaggeration)
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        torchaudio.save(a.out, wav, model.sr)
    except Exception as e:
        log(f"REFUSED: Chatterbox synthesis failed: {e}"); return 1
    log(f"voiceover ({len(text)} chars) -> {a.out}"); return 0


if __name__ == "__main__":
    raise SystemExit(main())
