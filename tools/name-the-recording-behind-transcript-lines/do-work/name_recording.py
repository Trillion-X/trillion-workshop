
usage: python3 -I package_lines.py <archive_index.json> <start-end> [<start-end> ...]

Prints every archive window that overlaps a range: window id, recording title,
its line span and the first words, so a cited passage can be found in our media.
"""
import json
import sys


def main():
    windows = json.load(open(sys.argv[1]))
    for spec in sys.argv[2:]:
        lo, hi = (int(x) for x in spec.split('-'))
        for w in windows:
            if w['start_line'] <= hi and w['end_line'] >= lo:
                print(f"{spec}\t{w['id']}\t{w['recording']}\t{w['start_line']}-{w['end_line']}\t{w['text'].strip()[:120]!r}")


main()
