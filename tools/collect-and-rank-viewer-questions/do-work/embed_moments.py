     time_basis "estimated".
Whisper loop output ("a little bit of a little bit...") is dropped by a unique-word ratio test.
Writes <out-dir>/moments.jsonl (clip, from, to, quote, time_basis, media_location) and moments.npy (bge-small-en-v1.5, normalized).
"""
import csv
import glob
import json
import os
import sys

import numpy as np
from sentence_transformers import SentenceTransformer

MIN_WORDS = 8
MAX_WORDS = 45


def distinct_enough(text):
    words = text.lower().split()
    return len(words) >= MIN_WORDS and len(set(words)) / len(words) >= 0.55


def sentences(words):
    current = []
    for word in words:
        current.append(word)
        ends = word["text"].rstrip().endswith((".", "?", "!"))
        if (ends and len(current) >= MIN_WORDS) or len(current) >= MAX_WORDS:
            yield current
            current = []
    if len(current) >= MIN_WORDS:
        yield current


def main():
    library, slate, out_dir = sys.argv[1:4]
    rows = []
