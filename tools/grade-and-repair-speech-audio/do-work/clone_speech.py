"""Re-voice, in the speaker's own voice, the exact words of spans that stay bad after the remaster.

  clone_speech.py --spans FILE --settings FILE --out DIR --reference FILE --reference-text TEXT [--tries 6]

Only the voice of the reference is ever cloned, and the reference must be a clean cut of a recording of the person who
agreed to be cloned. A span whose speaker does not match the reference (speaker_check.py, the settings'
speaker_similarity_min) is refused and keeps its best remaster. A span needs its words with times (spans.json `words`).

Model: the voice-cloning text-to-speech model named in the settings' clone_model (any model mlx-audio loads that takes a reference recording), run locally.

Timing: the span is split into phrases at the pauses of the original (word gap >= PAUSE, or any gap after a sentence end). Each phrase is cloned,
whisper-read (zero word errors against its words), stretched with atempo to the time the original phrase took (the
stretch must stay within settings clone_phrase_stretch_max or the take is refused) and laid at the original offset. So the cloned span has
the original length and every phrase starts where it started. A span passes only with zero word errors over the whole
span. Kept spans are marked cloned:true in grades.json.
"""
import argparse
import json
import os
import subprocess
import sys

import mlx.core as mx
import librosa
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "read-data"))

import grade_and_repair_speech as grader  # noqa: E402
import measure  # noqa: E402
from phrases import phrases  # noqa: E402
import reading  # noqa: E402
import speaker_check  # noqa: E402
import settings as settings_file  # noqa: E402
import spans as spans_file  # noqa: E402

SR = 48000


def synth(model, text, reference, seed):
    temperature = (0.8, 0.6, 1.0)[seed % 3]
    mx.random.seed(seed)
    x = np.concatenate([np.array(r.audio).reshape(-1) for r in model.generate(text=text, ref_audio=reference, temperature=temperature)])
    return librosa.effects.trim(x, top_db=35, frame_length=1024, hop_length=128)[0], model.sr


def stretched(x, sr, seconds, tmp):
    """Return x stretched to `seconds` at 48 kHz, and the ratio natural/target."""
    ratio = (len(x) / sr) / seconds
    sf.write(tmp + ".in.wav", x, sr, subtype="PCM_24")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp + ".in.wav", "-af", f"atempo={ratio:.5f}",
                    "-ar", str(SR), "-ac", "1", "-c:a", "pcm_f32le", tmp + ".out.wav"], check=True)
    y, _ = sf.read(tmp + ".out.wav", dtype="float32")
    return y, ratio


def clone_phrase(model, words, reference, tries, tmp, t):
    text = " ".join(w["text"] for w in words)
    slot = words[-1]["end"] - words[0]["start"]
    best = None
    for seed in range(tries):
        spoken = text if text.endswith((".", "?", "!")) else text.rstrip(",;:") + "."
        x, sr = synth(model, (spoken, spoken.rstrip("."), spoken.rstrip(".") + "!")[(seed // 3) % 3], reference, seed)
        if abs((len(x) / sr) / slot - 1) > t["clone_phrase_stretch_max"]:
            continue
        y, ratio = stretched(x, sr, slot, tmp)
        sf.write(tmp + ".read.wav", np.concatenate([np.zeros(int(t["handle_seconds"] * SR), np.float32), y]), SR)
        heard = reading.read(tmp + ".read.wav", t, tmp + ".read16.wav")
        if reading.errors(text, heard, t["spoken_forms"]) == 0:
            if best is None or abs(ratio - 1) < abs(best[1] - 1):
                best = (y, ratio, seed)
            if abs(ratio - 1) < 0.05:
                break
    return best


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spans", required=True, help="the spans file the grade was made from")
    ap.add_argument("--out", required=True, help="the folder grade_and_repair_speech.py wrote")
    ap.add_argument("--settings", required=True, help="the person's settings file, the one the grade was made with")
    ap.add_argument("--reference", required=True, help="a clean recording of the speaker, the voice to clone")
    ap.add_argument("--reference-text", required=True)
    ap.add_argument("--tries", type=int, default=6)
    a = ap.parse_args()
    t = settings_file.load(a.settings)
    h = t["handle_seconds"]
    state = json.load(open(grader.state_path(a.out)))
    unique = spans_file.load_spans(a.spans)
    model = load_model(t["clone_model"])
    out_dir = os.path.join(grader.work_dir(a.out), "clone")
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, "tmp")
    for sid, st in state.items():
        if st["grade"] != "clone" or st.get("cloned_wav"):
            continue
        sim = speaker_check.similarity(a.reference, os.path.join(grader.work_dir(a.out), "raw", f"{sid}.wav"))
        st["speaker_similarity"] = round(sim, 3)
        if sim < t["speaker_similarity_min"]:
            st["clone_refused"] = f"voice not verified as the reference voice (similarity {sim:.2f} < {t['speaker_similarity_min']})"
            print(sid, st["clone_refused"])
            continue
        span = unique[sid]
        words = [{**w, "start": w["start"] + h, "end": w["end"] + h} for w in spans_file.span_words(span.get("words"), span)]
        if not words:
            st["clone_refused"] = "the span has no words with times, so its phrases cannot be timed"
            print(sid, st["clone_refused"])
            continue
        total = st["audio_to"] - st["audio_from"]
        canvas = np.zeros(int(total * SR), np.float32)
        ratios, ok = [], True
        for ph in phrases(words):
            got = clone_phrase(model, ph, a.reference, a.tries, tmp, t)
            text = " ".join(w["text"] for w in ph)
            if got is None:
                print(sid, "phrase has no passing take:", text)
                ok = False
                break
            y, ratio, seed = got
            i = int(ph[0]["start"] * SR)
            canvas[i:i + len(y)] += y[: len(canvas) - i]
            ratios.append(ratio)
            print(sid, "phrase seed", seed, "stretch", round(ratio, 3), "|", text[:60], flush=True)
        if not ok:
            continue
        out = os.path.join(out_dir, f"{sid}.wav")
        sf.write(tmp + ".mix.wav", canvas, SR, subtype="PCM_24")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp + ".mix.wav", "-af",
                        f"loudnorm=I={t['remaster_target_lufs']}:TP={t['remaster_true_peak_db']}:LRA={t['remaster_loudness_range']}",
                        "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s24le", out], check=True)
        heard = reading.read(out, t, tmp + ".read16.wav")
        errors = reading.errors(st["text"], heard, t["spoken_forms"])
        print(sid, "whole span errors vs transcript:", errors, "span seconds", round(total - 2 * h, 2), flush=True)
        if errors == 0:
            st["cloned_wav"] = out
            st["clone"] = {"model": t["clone_model"], "reference": a.reference, "reference_text": a.reference_text,
                           "phrases": len(ratios), "stretch_min": round(min(ratios), 3), "stretch_max": round(max(ratios), 3),
                           "duration_seconds": round(total - 2 * h, 3)}
            st["clone_measure"] = measure.measure(out, [])
    json.dump(state, open(grader.state_path(a.out), "w"), indent=1)
    grader.write_result(a.out, list(unique), state, t)
