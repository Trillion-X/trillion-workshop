"""Building writing pairs on made-up messages: held-out threads never written, the same request writes the same bytes,
refusals say what to change, and a case renders the same for training and writing."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

WORK = Path(__file__).resolve().parent.parent / "do-work"
sys.path.insert(0, str(WORK))
from writing_common import render  # noqa: E402

FRAME = "Thread:\n{thread}\n\nSay this as me:\n{draft}"


def request(out, **over):
    pairs = [{"id": f"p{i}", "thread": "kept" if i % 3 else "held", "channel": "texting",
              "context": [{"who": "them", "words": f"question {i}"}], "draft": f"I will be there at {i}.",
              "words": f"there at {i} see u"} for i in range(30)]
    req = {"out_dir": str(out), "pairs": pairs, "held_out_threads": ["held"], "system": "Write as me in {channel}.",
           "frame": FRAME, "context_lines": 6, "min_characters": 5, "valid_share": 0.2, "seed": 1}
    req.update(over)
    return req


def build(req):
    r = subprocess.run([sys.executable, "-I", str(WORK / "build_writing_pairs.py"), "-"], input=json.dumps(req),
                       capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout.strip().splitlines()[-1])


def test_held_out_threads_are_never_written_and_bytes_repeat():
    with tempfile.TemporaryDirectory() as d:
        code, ans = build(request(Path(d) / "a"))
        assert code == 0, ans
        res = ans["result"]
        assert res["skipped"]["held_out_thread"] == 10
        assert res["files"]["train"]["rows"] + res["files"]["valid"]["rows"] == 20
        text = (Path(d) / "a" / "train.jsonl").read_text() + (Path(d) / "a" / "valid.jsonl").read_text()
        assert "there at 0 " not in text and "there at 3 " not in text
        _, again = build(request(Path(d) / "b"))
        assert again["result"]["files"]["train"]["blake3"] == res["files"]["train"]["blake3"]


def test_max_per_thread_caps_one_long_thread():
    with tempfile.TemporaryDirectory() as d:
        code, ans = build(request(Path(d), max_per_thread=5, valid_share=0.3))
        assert code == 0, ans
        res = ans["result"]
        assert res["skipped"]["over_thread_cap"] == 20
        assert res["skipped"]["held_out_thread"] == 5
        assert res["files"]["train"]["rows"] + res["files"]["valid"]["rows"] == 5
        code, ans = build(request(Path(d), max_per_thread=0))
        assert code == 2 and "max_per_thread" in ans["error"]


def test_refusals_say_what_to_change():
    with tempfile.TemporaryDirectory() as d:
        code, ans = build(request(Path(d), frame="no slots"))
        assert code == 2 and "{thread}" in ans["error"]
        req = request(Path(d))
        del req["held_out_threads"]
        code, ans = build(req)
        assert code == 2 and "held_out_threads is required" in ans["error"]
        code, ans = build(request(Path(d), valid_share=0))
        assert code == 2 and "valid" in ans["error"]


def test_render_shows_the_person_as_me_and_keeps_the_last_lines():
    case = {"channel": "texting", "draft": "Yes.", "context": [{"who": "them", "words": "a"}, {"who": "him", "words": "b"},
                                                               {"who": "them", "words": "c"}]}
    msgs = render(FRAME, "Write as me in {channel}.", case, 2)
    assert msgs[0]["content"] == "Write as me in texting."
    assert msgs[1]["content"] == "Thread:\nme: b\nthem: c\n\nSay this as me:\nYes."


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
