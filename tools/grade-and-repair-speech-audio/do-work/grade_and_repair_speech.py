"""Grade and repair the speech in a list of spans: keep the sound as is when it is good, remaster it when it is not.

  grade_and_repair_speech.py grade|all --spans spans.json --settings settings.json --out DIR [--deepfilternet-python PATH]

`grade` measures every span and says good or remaster. `all` also remasters the spans that failed. clone_speech.py
then re-voices what is still bad, and check_speech_by_reading.py reads every result back. The spans file is described
in read-data/spans.py, the settings (the person's microphone, room, loudness target and voice) in read-data/settings.py.
Source recordings are only read.

Work files live in DIR/work (one per unique span). The result is DIR/audio/<span id>.wav (the raw cut for good, the
remastered cut, or the cloned cut) and DIR/grades.json. Each audio file carries `handle_seconds` before the span's
`from` and after its `to`.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "read-data"))

import gap_duck  # noqa: E402
import grade_rules  # noqa: E402
import measure  # noqa: E402
import reading  # noqa: E402
import settings as settings_file  # noqa: E402
import spans as spans_file  # noqa: E402


def sh(args):
    subprocess.run(args, check=True, capture_output=True)


def work_dir(out):
    return os.path.join(out, "work")


def state_path(out):
    return os.path.join(work_dir(out), "state.json")


def finish_filter(t):
    """The finish every remaster candidate and every clone gets: de-ess, gentle compression, loudness."""
    return (
        f"deesser=i={t['deess_intensity']}:m={t['deess_max_reduction']}:f={t['deess_frequency']}:s=o,"
        f"acompressor=threshold={t['compressor_threshold_db']}dB:ratio={t['compressor_ratio']}:attack={t['compressor_attack_ms']}:"
        f"release={t['compressor_release_ms']}:makeup={t['compressor_makeup_db']},"
        f"loudnorm=I={t['remaster_target_lufs']}:TP={t['remaster_true_peak_db']}:LRA={t['remaster_loudness_range']}"
    )


def cut(s, sid, work, t):
    h = t["handle_seconds"]
    dst = os.path.join(work, "raw", f"{sid}.wav")
    if not os.path.exists(dst):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        start = max(0.0, s["from"] - h)
        sh(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-t", str(s["to"] - start + h), "-i", s["source"],
            "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s24le", dst])
    return dst


def words_for(s, t):
    """Words of the span with times relative to the start of the cut (which begins `handle_seconds` before `from`)."""
    shift = s["from"] - max(0.0, s["from"] - t["handle_seconds"])
    return [{"text": w["text"], "start": w["start"] + shift, "end": w["end"] + shift}
            for w in spans_file.span_words(s.get("words"), s)]


def candidates(sid, unique, state, work, t, with_dfn):
    """The remaster candidates for one span: DeepFilterNet full and soft when it is installed, and ffmpeg afftdn.

    Each gets the same finish (duck the room in pauses when the room was the fault, then finish_filter), is measured and
    whisper-read. Returns {name: {wav, measure, vs_original, vs_transcript}} and the word errors between the original
    read and the transcript.
    """
    d = os.path.join(work, "remaster")
    raw = state[sid]["raw"]
    text = state[sid]["text"]
    forms = t["spoken_forms"]
    sources = {"afftdn": os.path.join(d, f"{sid}.afftdn.wav")}
    if with_dfn:
        sources = {"dfn": os.path.join(d, f"{sid}.dfn.wav"), "dfn-soft": os.path.join(d, f"{sid}.dfn.soft.wav"), **sources}
    room = raw["tail_samples"] >= t["room_tail_min_samples"] and raw["room_tail_db"] > t["room_tail_db_max"]
    original = reading.cached_read(os.path.join(work, "raw", f"{sid}.wav"), t, work)
    out = {}
    for name, src in sources.items():
        if room:
            gap_duck.duck_file(src, src, words_for(unique[sid], t), t["duck_db"], t["duck_min_gap_seconds"])
        wav = os.path.join(d, f"{sid}.{name}.final.wav")
        sh(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-af", finish_filter(t), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s24le", wav])
        heard = reading.cached_read(wav, t, work)
        out[name] = {"wav": wav, "measure": measure.measure(wav, words_for(unique[sid], t)),
                     "vs_original": reading.errors(original, heard, forms), "vs_transcript": reading.errors(text, heard, forms)}
    return out, reading.errors(original, text, forms)


def remaster(sids, unique, state, work, t, dfn_python):
    """highpass (and a notch at the hum and its harmonics), then the best of the denoisers by whisper read."""
    d = os.path.join(work, "remaster")
    os.makedirs(d, exist_ok=True)
    jobs = []
    for sid in sids:
        raw = state[sid]["raw"]
        pre = f"highpass=f={t['highpass_hz']}"
        if raw["hum_prominence_db"] >= t["hum_prominence_db_max"]:
            for k in (1, 2, 3):
                pre += f",equalizer=f={raw['hum_hz'] * k}:width_type=q:w={t['hum_notch_q']}:g={t['hum_notch_gain_db']}"
        sh(["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(work, "raw", f"{sid}.wav"), "-af", pre,
            "-ar", "48000", "-c:a", "pcm_f32le", os.path.join(d, f"{sid}.in.wav")])
        sh(["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(d, f"{sid}.in.wav"), "-af",
            f"afftdn=nr={t['denoise_reduction_db']}:nf={max(-80, raw['noise_floor_dbfs'])}:tn=1", "-c:a", "pcm_f32le",
            os.path.join(d, f"{sid}.afftdn.wav")])
        jobs += [os.path.join(d, f"{sid}.in.wav"), os.path.join(d, f"{sid}.dfn.wav")]
    if jobs and dfn_python:
        subprocess.run([dfn_python, os.path.join(HERE, "dfn_batch.py"), str(t["denoise_soft_limit_db"]), *jobs], check=True)
    for sid in sids:
        st = state[sid]
        cands, source_vs_transcript = candidates(sid, unique, state, work, t, bool(dfn_python))
        ok = [n for n, c in cands.items() if c["vs_original"] == 0 or c["vs_transcript"] == 0]
        best = max(ok or list(cands),
                   key=lambda n: (-min(cands[n]["vs_original"], cands[n]["vs_transcript"]), cands[n]["measure"]["snr_db"]))
        c = cands[best]
        st["remaster_choice"] = best
        st["remaster_candidates"] = {n: {"snr_db": x["measure"]["snr_db"], "vs_original": x["vs_original"],
                                         "vs_transcript": x["vs_transcript"]} for n, x in cands.items()}
        st["remastered"] = c["measure"]
        st["regrade"], st["regrade_reasons"] = grade_rules.grade_after_remaster(c["measure"], t)
        st["words_uncertain"] = source_vs_transcript >= t["words_uncertain_errors"]
        if best not in ok:
            st["regrade_reasons"].append(
                f"read: best candidate differs from the original read by {c['vs_original']} and from the transcript by "
                f"{c['vs_transcript']} words")
            if min(c["vs_original"], c["vs_transcript"]) >= t["garbled_errors"] and not st["words_uncertain"]:
                st["regrade"] = "clone"
        st["grade"] = st["regrade"]
        st["treatment"] = "remastered" if st["regrade"] == "remaster" else "needs-clone"
        st["final_wav"] = c["wav"] if st["regrade"] == "remaster" else None
        st["fallback_wav"] = c["wav"]
        print(sid, "->", st["regrade"], best, st["remaster_candidates"],
              "words_uncertain" if st["words_uncertain"] else "", flush=True)


def run(stage, spans_path, out, t, dfn_python):
    """Grade (and, for `all`, remaster) every span of the spans file. Returns the unique spans in file order and the state."""
    unique = spans_file.load_spans(spans_path)
    work = work_dir(out)
    os.makedirs(work, exist_ok=True)
    state = json.load(open(state_path(out))) if os.path.exists(state_path(out)) else {}
    h = t["handle_seconds"]
    for sid, s in unique.items():
        raw = cut(s, sid, work, t)
        st = state.setdefault(sid, {})
        st["audio_from"] = round(max(0.0, s["from"] - h), 3)
        st["audio_to"] = round(s["to"] + h, 3)
        st["clip"] = s["clip"]
        st["text"] = s["text"]
        st["raw"] = measure.measure(raw, words_for(s, t))
        st["grade"], st["reasons"] = grade_rules.grade_raw(st["raw"], t)
        st["treatment"] = "as-is" if st["grade"] == "good" else None
        st["final_wav"] = raw if st["grade"] == "good" else None
        for stale in ("remastered", "remaster_choice", "remaster_candidates", "regrade_reasons", "words_uncertain"):
            st.pop(stale, None)
        print(sid, st["grade"], flush=True)
    if stage == "all":
        remaster([sid for sid in unique if state[sid]["grade"] != "good"], unique, state, work, t, dfn_python)
    json.dump(state, open(state_path(out), "w"), indent=1)
    return list(unique), state


def write_result(out, sids, state, t):
    audio = os.path.join(out, "audio")
    shutil.rmtree(audio, ignore_errors=True)
    os.makedirs(audio)
    result = {"handle_seconds": t["handle_seconds"], "settings": t, "spans": {}}
    counts = {"good": 0, "remaster": 0, "clone": 0}
    for sid in sids:
        st = state[sid]
        cloned = st["grade"] == "clone" and st.get("cloned_wav")
        refused = st["grade"] == "clone" and not cloned
        wav = cloned or st["final_wav"] or (st["fallback_wav"] if refused else None)
        keys = ("grade", "reasons", "treatment", "audio_from", "audio_to", "raw", "remastered", "remaster_choice",
                "remaster_candidates", "regrade_reasons", "words_uncertain", "clone", "speaker_similarity")
        entry = {k: st[k] for k in keys if k in st}
        if wav:
            shutil.copyfile(wav, os.path.join(out, spans_file.graded_audio_name(sid)))
            entry["audio"] = spans_file.graded_audio_name(sid)
        entry["cloned"] = bool(cloned)
        if refused:
            entry["not_cloned"] = st.get("clone_refused", "no clone take passed") + "; the audio file is the best remaster"
        result["spans"][sid] = entry
        counts[entry["grade"]] += 1
    result["counts"] = counts
    json.dump(result, open(os.path.join(out, "grades.json"), "w"), indent=1)
    print(json.dumps({"result": {"grades": os.path.join(out, "grades.json"), "counts": counts}}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["grade", "all"])
    ap.add_argument("--spans", required=True, help="the spans file (see read-data/spans.py)")
    ap.add_argument("--settings", required=True, help="the person's settings file (see read-data/settings-keys.json)")
    ap.add_argument("--out", required=True, help="the folder to write grades.json, audio/ and work/ into")
    ap.add_argument("--deepfilternet-python", help="a python that has DeepFilterNet installed; without it the remaster tries ffmpeg afftdn only")
    a = ap.parse_args()
    settings = settings_file.load(a.settings)
    write_result(a.out, *run(a.stage, a.spans, a.out, settings, a.deepfilternet_python), settings)
