"""Make vector sets of picture vectors that other programs already kept, so tool:find-similar-to-a-vector and
tool:find-closest-across-my-indexes can search them. Ported from a film repository's tools/clip-search/q.py (5a9ba39),
the part that read its stores; the stores are arguments now and each becomes a set instead of being searched here.

  make_vector_set_from_kept_vectors.py --out DIR [--asset-index DIR] [--ssd-index DIR] [--expansion-results FILE]
                                       [--namespace FILE] [--kind video|image|all]

--asset-index        a folder of CLIP matrices: clip-video-embeddings.npy + clip-video-ids.json (video frames, no time),
                     clip-embeddings.npy + clip-ids.json (images), and assets.jsonl (rows of path and display_path or
                     name: each item's readable name).
--ssd-index          a folder of frames.npy + frames.jsonl (rows of path and t), as make_picture_vector_set.py writes.
--expansion-results  an app's SQLite results store: table results(identity, kind, value); kind picture-vectors holds
                     JSON { dims?, frames: [{ v: base64 float16 vector, t: seconds }] }, kind library-entry { path }.
--namespace          a namespace store (table versions): each Expansion item also carries `b2`, the id the namespace
                     keeps the video under.
--kind               which stores to read, as q.py: video, image or all (default all).

Writes, in --out/<index> for each store read (asset-index-video, asset-index-image, clip-index-ssd,
expansion-picture-vectors):
  items.jsonl      one line per vector: `path`, `kind`, `t` (seconds, or null when the store keeps no time), and `name`
                   (asset index), or `id` and `b2` (Expansion)
  vectors.npy      float16, one L2-normalised row per item, in the order of items.jsonl
  vector-set.json  the `vector_set` member for the person's semantic-index-descriptor record, its `carry` naming the
                   extra fields
Every source is opened read-only. The last line is {"result": {"sets": {index: items}}} or {"error": ...}. Needs numpy.
"""
import argparse, base64, json, os, sqlite3, sys
import numpy as np

ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
ap.add_argument("--out", required=True)
ap.add_argument("--asset-index")
ap.add_argument("--ssd-index")
ap.add_argument("--expansion-results")
ap.add_argument("--namespace")
ap.add_argument("--kind", choices=["video", "image", "all"], default="all")
a = ap.parse_args()
if not (a.asset_index or a.ssd_index or a.expansion_results):
    print(json.dumps({"error": "give at least one store: --asset-index, --ssd-index or --expansion-results"}))
    sys.exit(1)
ASSET_INDEX = a.asset_index or ""
SSD_INDEX = a.ssd_index or ""
EXPANSION_DB = a.expansion_results or ""
NAMESPACE_DB = a.namespace or ""
expansion_id, b2_id = {}, {}   # Expansion picture-vectors items: path -> Expansion identity -> B2 namespace id

# Each store: vectors plus one owner per vector (path, kind, seconds or None).
stores = []
def asset_store(vec_file, id_file, kind):
    if not ASSET_INDEX:
        return
    v = np.load(os.path.join(ASSET_INDEX, vec_file)).astype(np.float32)
    stores.append((v / np.linalg.norm(v, axis=1, keepdims=True),
                   [(p, kind, None) for p in json.load(open(os.path.join(ASSET_INDEX, id_file)))], "asset-index"))
if a.kind in ("video", "all"):
    asset_store("clip-video-embeddings.npy", "clip-video-ids.json", "video-frame")
    if os.path.exists(os.path.join(SSD_INDEX, "frames.npy")):
        rows = [json.loads(l) for l in open(os.path.join(SSD_INDEX, "frames.jsonl"))]
        v = np.load(os.path.join(SSD_INDEX, "frames.npy")).astype(np.float32)
        n = min(len(v), len(rows))  # while index_ssd.py runs, the two files may be one clip apart
        stores.append((v[:n], [(r["path"], "video-frame", r["t"]) for r in rows[:n]], "clip-index-ssd"))
    if os.path.exists(EXPANSION_DB):
        # The Expansion app's picture-vectors: up to 16 frames per video, one every 6 s, with their time.
        db = sqlite3.connect(f"file:{EXPANSION_DB}?mode=ro&immutable=1", uri=True)
        entry = {i: json.loads(v) for i, v in db.execute("select identity, value from results where kind='library-entry'")}
        vecs, owners = [], []
        for ident, value in db.execute("select identity, value from results where kind='picture-vectors'"):
            doc = json.loads(value)
            for fr in doc.get("frames", []):
                v = np.frombuffer(base64.b64decode(fr["v"]), dtype=np.float16)
                if v.size == doc.get("dims", 512):
                    vecs.append(v)
                    owners.append((entry.get(ident, {}).get("path") or ident, "video-frame", fr.get("t") or 0.0))
                    expansion_id[owners[-1][0]] = ident
        if vecs:
            v = np.stack(vecs).astype(np.float32)
            stores.append((v / np.linalg.norm(v, axis=1, keepdims=True), owners, "expansion-picture-vectors"))
        if os.path.exists(NAMESPACE_DB):
            # Which of those videos the B2 namespace holds, and under which id (b2_audio_window.py reads by it).
            for i, body in sqlite3.connect(f"file:{NAMESPACE_DB}?mode=ro&immutable=1", uri=True).execute(
                    "select id, body from versions where resource='@namespace/aliases' and id like '12:%' "
                    "and valid_to=9223372036854775807 and deleted=0"):
                b2_id[i] = json.loads(body).get("identity", "")
if a.kind in ("image", "all"):
    asset_store("clip-embeddings.npy", "clip-ids.json", "image")

# The asset vectors name content-addressed paths; the asset rows give the readable name.
wanted = {p for _, owners, index in stores if index == "asset-index" for p, _, _ in owners}
names = {}
if wanted and os.path.exists(os.path.join(ASSET_INDEX, "assets.jsonl")):
    with open(os.path.join(ASSET_INDEX, "assets.jsonl")) as f:
        for line in f:
            if '"path"' not in line:
                continue
            row = json.loads(line)
            if row.get("path") in wanted:
                names[row["path"]] = row.get("display_path") or row.get("name")


def item(path, kind, t, index):
    """One line of items.jsonl: what the vector is, and the fields the descriptor's points_to.carry names."""
    if index == "asset-index":
        return {"path": path, "kind": kind, "t": t, "name": names.get(path, os.path.basename(path))}
    if index == "expansion-picture-vectors":
        return {"path": path, "kind": kind, "t": t, "id": expansion_id.get(path), "b2": b2_id.get(expansion_id.get(path))}
    return {"path": path, "kind": kind, "t": t}


CARRY = {"asset-index": ["kind", "name"], "expansion-picture-vectors": ["kind", "id", "b2"], "clip-index-ssd": ["kind"]}
written = {}
for vectors, owners, index in stores:
    name = f"{index}-{'image' if owners and owners[0][1] == 'image' else 'video'}" if index == "asset-index" else index
    out = os.path.join(a.out, name)
    os.makedirs(out, exist_ok=True)
    items_path, vectors_path = os.path.join(out, "items.jsonl"), os.path.join(out, "vectors.npy")
    with open(items_path + ".tmp", "w") as f:
        f.write("".join(json.dumps(item(p, kind, t, index)) + "\n" for p, kind, t in owners))
    v = np.asarray(vectors, dtype=np.float32)
    np.save(vectors_path + ".tmp.npy", (v / np.linalg.norm(v, axis=1, keepdims=True)).astype(np.float16))
    os.replace(items_path + ".tmp", items_path)
    os.replace(vectors_path + ".tmp.npy", vectors_path)
    with open(os.path.join(out, "vector-set.json"), "w") as f:
        json.dump({"vector_set": {"items": {"file": items_path}, "vectors": {"file": vectors_path},
                                  "points_to": {"file": "path", "start": "t", "carry": CARRY[index]}}, "items": len(owners)}, f, indent=1)
    written[name] = len(owners)
print(json.dumps({"result": {"sets": written}}))
