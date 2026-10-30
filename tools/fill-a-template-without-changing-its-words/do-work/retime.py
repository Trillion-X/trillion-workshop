#!/usr/bin/env python3
"""retime.py <piece.json> <transcript.json> <out.piece.json> [--report]

Events bound to words, not seconds. A token with a `bound_to` field ({"words", "edge", "offset_s"}, optional "slot"
and "occurrence") responds to a word or phrase. Give the word-timed transcript of the rewritten script (what
any speech-to-text tool writes for the new voice-over) and every bound token moves to where its words now play. A token
whose words are not in the new transcript keeps its time and is listed, never guessed.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'read-data'))
from wt_core import READERS, Registry, WTError, load_json, write_json  # noqa: E402
from wt_ops import retime  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("piece")
    ap.add_argument("transcript")
    ap.add_argument("out")
    ap.add_argument("--report", action="store_true", help="list every bound token and where it went")
    a = ap.parse_args(argv)
    try:
        piece = load_json(a.piece, "piece")
        reg = Registry.load(piece.get("registry"))
        words = READERS["transcript_words"](Path(a.transcript), {})
        out = retime(piece, words, reg)
        write_json(a.out, out)
        rows = out["notes"]["retime"]
        moved = [r for r in rows if r["status"] == "moved"]
        print(f"{a.out}: {len(moved)} of {len(rows)} bound tokens re-timed from the new words")
        for r in rows:
            if a.report or r["status"] != "moved":
                why = f" ({r['why']})" if r.get("why") else ""
                print(f"  {r['token']}: {r['status']}: {r['phrase']!r} {r['from']} -> {r['to']}{why}")
    except WTError as e:
        print(f"retime: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
