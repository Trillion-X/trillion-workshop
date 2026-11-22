"""Build the chat rows that teach a small model to write as the person: (thread so far + a plain draft) -> what they
really sent.

usage: python3 -I build_writing_pairs.py <request.json | ->

Request: {out_dir, pairs, held_out_threads, system, frame, context_lines, min_characters, valid_share, seed}, or
settings_record with the person's `build` settings under it. `pairs` are rows {id, thread, channel, context, draft,
words} (inline or {"file": a JSON Lines file}): `words` is what the person sent, `draft` a plain wording of it made the
same way the cases it will be measured on were made. A pair whose thread is held out is never written, not even to
valid. Each kept pair lands in valid when the BLAKE3 of its id, read as a number in [0, 1), is below valid_share, so the
same request writes the same files byte for byte. Writes train.jsonl and valid.jsonl ({messages}) and answers their
counts and BLAKE3s."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from writing_common import FOLDER, Refused, blake3_of, need, render, rows_of, run, with_settings  # noqa: E402


def share_of(text):
    import blake3
    return int(blake3.blake3(text.encode()).hexdigest()[:12], 16) / float(1 << 48)


def main(req):
    req = with_settings(req, "build", FOLDER)
    out = Path(need(req, "out_dir", str, "the folder train.jsonl and valid.jsonl are written to")).expanduser()
    pairs = rows_of(need(req, "pairs", (list, dict), "rows {id, thread, channel, context, draft, words}"), "pairs")
    held = set(need(req, "held_out_threads", list, "the threads the measuring cases come from; none of their lines is trained on"))
    system = need(req, "system", str, "the system words every row starts with (may hold {channel})")
    frame = need(req, "frame", str, "the user words, holding {thread} and {draft}")
    context_lines = need(req, "context_lines", int, "how many lines of the thread before the message are shown")
    min_chars = need(req, "min_characters", int, "the shortest message kept")
    valid_share = need(req, "valid_share", (int, float), "the share of pairs kept for validation")
    out.mkdir(parents=True, exist_ok=True)
    seen, kept, skipped = set(), {"train": [], "valid": []}, {"held_out_thread": 0, "no_draft": 0, "short": 0, "repeat": 0}
    for p in pairs:
        if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not isinstance(p.get("words"), str):
            raise Refused("each pair needs an id and words (text)")
        if p.get("thread") in held:
            skipped["held_out_thread"] += 1
            continue
        if not str(p.get("draft") or "").strip():
            skipped["no_draft"] += 1
            continue
        if len(p["words"].strip()) < min_chars:
            skipped["short"] += 1
            continue
        if p["id"] in seen:
            skipped["repeat"] += 1
            continue
        seen.add(p["id"])
        row = {"messages": render(frame, system, p, context_lines) + [{"role": "assistant", "content": p["words"].strip()}]}
        kept["valid" if share_of(p["id"]) < valid_share else "train"].append((p["id"], row))
    if not kept["train"] or not kept["valid"]:
        raise Refused(f"train and valid both need rows; kept {len(kept['train'])} train and {len(kept['valid'])} valid "
                      f"(skipped {skipped}): give more pairs or another valid_share")
    files = {}
    for side, rows in kept.items():
        path = out / f"{side}.jsonl"
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for _, r in sorted(rows, key=lambda x: x[0])))
        files[side] = {"file": str(path), "rows": len(rows), "blake3": blake3_of(path)}
    return {"files": files, "skipped": skipped, "held_out_threads": sorted(held)}


if __name__ == "__main__":
    sys.exit(run(main, sys.argv[1:]))
