# Each store: vectors plus one owner per vector (path, kind, seconds or None).
stores = []
def asset_store(vec_file, id_file, kind):
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
