"""Whisper reads and word-error counting, shared by the remaster selection, the clone and the read-back check.

The language and the spoken forms a read and a text may spell differently are the person's settings (settings.py).
"""
import json
import os
import re
import subprocess


def norm(text, spoken_forms):
    """The words of `text`: lower case, punctuation gone, each spoken form written as the words it counts as."""
    text = re.sub(r"[^\w' ]+", " ", text.lower().replace("’", "'"))
    return " ".join(spoken_forms.get(w, w) for w in text.split()).split()


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def errors(expected, heard, spoken_forms):
    return edit_distance(norm(expected, spoken_forms), norm(heard, spoken_forms))


def read(wav, settings, tmp):
    """Whisper-read the part of `wav` between its handles, through the scratch file `tmp`."""
    import mlx_whisper

    h = settings["handle_seconds"]
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ss", str(h), "-af",
                    f"areverse,atrim=start={h},areverse", "-ar", "16000", "-ac", "1", tmp], check=True)
    return mlx_whisper.transcribe(tmp, path_or_hf_repo=settings["read_model"], language=settings["language"], condition_on_previous_text=False,
                                  temperature=0.0)["text"].strip()


def cached_read(wav, settings, work):
    """read(), remembered in work/reads.json by the file's path, size and time, and the language read in."""
    path = os.path.join(work, "reads.json")
    reads = json.load(open(path)) if os.path.exists(path) else {}
    # the key holds the whole settings, so a read is reused only under the settings it was made with
    key = f"{os.path.abspath(wav)}:{os.path.getsize(wav)}:{os.path.getmtime(wav)}:{json.dumps(settings, sort_keys=True)}"
    if key not in reads:
        reads[key] = read(wav, settings, os.path.join(work, "reading.wav"))
        json.dump(reads, open(path, "w"), indent=1)
    return reads[key]
