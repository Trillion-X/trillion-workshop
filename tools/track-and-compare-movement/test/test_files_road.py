"""files_road.keep sends a file of any size: one raw piece per 32 MiB at its offset, then finish, and trusts the answer
only when its identity is the local file's BLAKE3. A pose model is 300 MB; the one-piece keep refused it (Nov 25 2026).
The engine command is replaced by a stand-in that keeps the bytes it is sent, so no engine and no Files are used."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

DO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work")
sys.path.insert(0, DO)
import files_road  # noqa: E402

STAND_IN = r'''
import json, os, subprocess, sys
store = os.environ["FAKE_FILES"]
args = sys.argv[1:]
upload = args[args.index("--upload") + 1] if "--upload" in args else None
call = json.loads(args[args.index("tools:run") + 1])["call"]
name, a = call["name"], call["arguments"]
data = os.path.join(store, a.get("upload_id", "x") + ".bin")
log = os.path.join(store, "calls.jsonl")
open(log, "a").write(json.dumps({"name": name, "offset": a.get("offset")}) + "\n")
if name == "write_file_start":
    open(data, "wb").close(); out = {"state": "open"}
elif name == "write_file_piece":
    have = os.path.getsize(data)
    if a["offset"] != have:
        out = {"code": "wrong_offset", "next_offset": have}
    else:
        open(data, "ab").write(open(upload, "rb").read()); out = {"next_offset": os.path.getsize(data)}
elif name == "write_file_finish":
    ident = subprocess.run(["b3sum", "--no-names", data], capture_output=True, text=True).stdout.strip()
    out = {"identity": "1f:" + ident}
print(json.dumps({"result": {"structuredContent": out}}))
'''


@unittest.skipIf(shutil.which("b3sum") is None, "b3sum is not installed")
class KeepAnySize(unittest.TestCase):
    def keep(self, size, piece):
        with tempfile.TemporaryDirectory() as d:
            stand_in = os.path.join(d, "engine.py")
            open(stand_in, "w").write(STAND_IN)
            path = os.path.join(d, "model.bin")
            with open(path, "wb") as f:
                f.write(os.urandom(size))
            os.environ["FAKE_FILES"] = d
            got = files_road.keep([sys.executable, stand_in], path, "/Models/model.bin", "application/octet-stream",
                                  piece=piece)
            calls = [json.loads(line) for line in open(os.path.join(d, "calls.jsonl"))]
            return got, files_road.blake3_identity(path), calls

    def test_a_large_file_goes_in_pieces_at_their_offsets(self):
        got, want, calls = self.keep(2500, piece=1000)
        self.assertEqual(got, want)
        self.assertEqual([c["offset"] for c in calls if c["name"] == "write_file_piece"], [0, 1000, 2000])

    def test_a_small_file_is_one_piece(self):
        got, want, calls = self.keep(300, piece=1000)
        self.assertEqual(got, want)
        self.assertEqual(sum(c["name"] == "write_file_piece" for c in calls), 1)

    def test_a_file_of_exactly_one_piece_is_one_piece(self):
        got, want, calls = self.keep(1000, piece=1000)
        self.assertEqual(got, want)
        self.assertEqual(sum(c["name"] == "write_file_piece" for c in calls), 1)


if __name__ == "__main__":
    unittest.main()
