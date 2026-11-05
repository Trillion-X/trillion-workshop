"""Tests of do-work/make_vector_set_from_kept_vectors.py on a made-up asset index, SSD frames, results store and
namespace store, each run the way the person runs it."""
import base64
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

import numpy as np

TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work", "make_vector_set_from_kept_vectors.py")


def run(*args):
    done = subprocess.run([sys.executable, "-I", TOOL, *args], capture_output=True, text=True)
    return done.returncode, json.loads(done.stdout.strip().splitlines()[-1]), done.stderr


def lines(path):
    return [json.loads(line) for line in open(path)]


def frame(vector, t):
    return {"v": base64.b64encode(np.array(vector, dtype=np.float16).tobytes()).decode(), "t": t}


def asset_index(work):
    folder = os.path.join(work, "assets")
    os.makedirs(folder)
    np.save(os.path.join(folder, "clip-video-embeddings.npy"), np.array([[3.0, 4.0], [0.0, 2.0]], dtype=np.float32))
    json.dump(["/made/up/one.mp4", "/made/up/two.mp4"], open(os.path.join(folder, "clip-video-ids.json"), "w"))
    np.save(os.path.join(folder, "clip-embeddings.npy"), np.array([[1.0, 0.0]], dtype=np.float32))
    json.dump(["/made/up/still.jpg"], open(os.path.join(folder, "clip-ids.json"), "w"))
    with open(os.path.join(folder, "assets.jsonl"), "w") as f:
        f.write(json.dumps({"path": "/made/up/one.mp4", "display_path": "Folder/One.mp4"}) + "\n")
        f.write(json.dumps({"name": "no path here"}) + "\n")
        f.write(json.dumps({"path": "/elsewhere.jpg", "display_path": "Not wanted"}) + "\n")
    return folder


def results_store(work):
    db = os.path.join(work, "results.sqlite")
    con = sqlite3.connect(db)
    con.execute("create table results(identity text, kind text, value text)")
    con.executemany("insert into results values (?,?,?)", [
        ("12:v1", "library-entry", json.dumps({"path": "/made/up/three.mp4"})),
        ("12:v1", "picture-vectors", json.dumps({"dims": 2, "frames": [frame([1, 0], 0), frame([0, 1], 6), frame([1, 1, 1], 12)]})),
        ("12:v2", "picture-vectors", json.dumps({"dims": 2, "frames": [frame([2, 0], None)]})),
        ("12:v1", "other", "{}"),
    ])
    con.commit()
    con.close()
    return db


def namespace_store(work):
    db = os.path.join(work, "namespace.sqlite")
    con = sqlite3.connect(db)
    con.execute("create table versions(id text, body text, resource text, valid_to integer, deleted integer)")
    con.executemany("insert into versions values (?,?,?,?,?)", [
        ("12:v1", json.dumps({"identity": "made-up-stored-id"}), "@namespace/aliases", 9223372036854775807, 0),
        ("12:v2", json.dumps({"identity": "an-old-id"}), "@namespace/aliases", 5, 0),
    ])
    con.commit()
    con.close()
    return db


class AssetIndex(unittest.TestCase):
    def test_videos_and_images_become_sets_with_readable_names(self):
        with tempfile.TemporaryDirectory() as work:
            code, answer, err = run("--asset-index", asset_index(work), "--out", os.path.join(work, "sets"))
            self.assertEqual(code, 0, err)
            self.assertEqual(answer["result"]["sets"], {"asset-index-video": 2, "asset-index-image": 1})
            video = os.path.join(work, "sets", "asset-index-video")
            self.assertEqual([(i["path"], i["name"], i["t"], i["kind"]) for i in lines(os.path.join(video, "items.jsonl"))],
                             [("/made/up/one.mp4", "Folder/One.mp4", None, "video-frame"), ("/made/up/two.mp4", "two.mp4", None, "video-frame")])
            vectors = np.load(os.path.join(video, "vectors.npy"))
            self.assertEqual(vectors.dtype, np.float16)
            self.assertTrue(np.allclose(vectors[0].astype(np.float32), [0.6, 0.8], atol=1e-3))
            made = json.load(open(os.path.join(video, "vector-set.json")))
            self.assertEqual(made["vector_set"]["points_to"], {"file": "path", "start": "t", "carry": ["kind", "name"]})

    def test_kind_image_reads_only_the_images(self):
        with tempfile.TemporaryDirectory() as work:
            code, answer, err = run("--asset-index", asset_index(work), "--kind", "image", "--out", os.path.join(work, "sets"))
            self.assertEqual((code, answer["result"]["sets"]), (0, {"asset-index-image": 1}), err)


class Frames(unittest.TestCase):
    def test_ssd_frames_pass_through_with_their_times_and_a_short_file_is_cut(self):
        with tempfile.TemporaryDirectory() as work:
            np.save(os.path.join(work, "frames.npy"), np.array([[1, 0], [0, 1], [1, 1]], dtype=np.float16))
            with open(os.path.join(work, "frames.jsonl"), "w") as f:
                f.write("".join(json.dumps({"path": "/made/up/clip.mp4", "t": t}) + "\n" for t in (0, 2)))
            code, answer, err = run("--ssd-index", work, "--out", os.path.join(work, "sets"))
            self.assertEqual((code, answer["result"]["sets"]), (0, {"clip-index-ssd": 2}), err)
            items = lines(os.path.join(work, "sets", "clip-index-ssd", "items.jsonl"))
            self.assertEqual([(i["path"], i["t"]) for i in items], [("/made/up/clip.mp4", 0), ("/made/up/clip.mp4", 2)])


class ResultsStore(unittest.TestCase):
    def test_frames_become_timed_items_a_wrong_sized_vector_is_skipped_and_the_b2_id_is_carried(self):
        with tempfile.TemporaryDirectory() as work:
            code, answer, err = run("--expansion-results", results_store(work), "--namespace", namespace_store(work), "--out", os.path.join(work, "sets"))
            self.assertEqual((code, answer["result"]["sets"]), (0, {"expansion-picture-vectors": 3}), err)
            out = os.path.join(work, "sets", "expansion-picture-vectors")
            items = lines(os.path.join(out, "items.jsonl"))
            self.assertEqual([(i["path"], i["t"], i["id"], i["b2"]) for i in items],
                             [("/made/up/three.mp4", 0, "12:v1", "made-up-stored-id"), ("/made/up/three.mp4", 6, "12:v1", "made-up-stored-id"), ("12:v2", 0.0, "12:v2", None)])
            self.assertEqual(np.load(os.path.join(out, "vectors.npy")).shape, (3, 2))
            self.assertEqual(json.load(open(os.path.join(out, "vector-set.json")))["vector_set"]["points_to"]["carry"], ["kind", "id", "b2"])

    def test_the_stores_are_only_read(self):
        with tempfile.TemporaryDirectory() as work:
            db, ns = results_store(work), namespace_store(work)
            before = (open(db, "rb").read(), open(ns, "rb").read())
            run("--expansion-results", db, "--namespace", ns, "--out", os.path.join(work, "sets"))
            self.assertEqual((open(db, "rb").read(), open(ns, "rb").read()), before)

    def test_no_store_is_refused(self):
        with tempfile.TemporaryDirectory() as work:
            code, answer, _ = run("--out", os.path.join(work, "sets"))
            self.assertEqual(code, 1)
            self.assertIn("give at least one store", answer["error"])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=0).result
    if result.wasSuccessful():
        print("all tests passed")
    sys.exit(0 if result.wasSuccessful() else 1)
