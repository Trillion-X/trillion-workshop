"""tools/match/viewpoint_index.py — Exact sublinear view-family retrieval (S7 / P7 / L099).

The view-family hard gate (`viewpoint_dist(query, window) <= view_max`) used to be an O(total) linear scan over
every window in the index. This indexes that cheap hard gate: a BallTree over `viewpoint_embed(vec)` for every
index window, queried with `query_radius(view_max)` to return EXACTLY the windows inside the view family in
~O(log n + k) instead of O(n).

WHY IT IS EXACT (no admissibility risk, unlike the rejected LB_Keogh prefilter): `match_clips.viewpoint_embed`
maps the viewpoint vec into a space where plain Euclidean L2 == `viewpoint_dist` (the |ear_sign| embedding is the
algebraic equivalent of the min-over-mirror chiral term — proven byte-identical over 47,850 pairs). A Euclidean
ball-tree radius query therefore returns the IDENTICAL set the linear scan would pass — it only removes the
wasted iteration over out-of-family windows. The expensive certified-DTW still runs on the in-family pool; the
within-view pool size is bounded by data density in that viewpoint neighbourhood, not by the total index size.

Cached per `index_dir` (rebuilt only when the desc files change), so every query after the first is sublinear.
"""
from __future__ import annotations
import glob, json, sys
from pathlib import Path
import numpy as np
from sklearn.neighbors import BallTree

from match_clips import viewpoint_embed
import finite_json as FJ  # #198.1 serialization waist — a non-finite descriptor is rejected on read (NonFiniteJSON ⊂ ValueError → existing skip path)

_CACHE: dict = {}  # index_dir(str) -> (signature, ViewpointIndex)


class ViewpointIndex:
    """A built BallTree over embedded viewpoint vectors + the parallel (key, window_idx, desc_path) refs."""

    def __init__(self, tree, refs, total_windows, skipped_json=0, skipped_window=0):
        self.tree = tree                  # BallTree over embedded points, or None if the index has no view vecs
        self.refs = refs                  # [(key, window_idx, desc_path)] parallel to the tree's rows
        self.total_windows = total_windows  # every window seen (incl. windows with no view vec) — diagnostics
        self.skipped_json = skipped_json      # unparseable desc files (surfaced, not silently lost — Codex round-2 #5)
        self.skipped_window = skipped_window  # malformed/non-finite view windows skipped at build (diagnostics)

    def query(self, qvec, radius):
        """Return a SOUND OVER-APPROXIMATION of {windows with viewpoint_dist(qvec, w) <= radius} as
        [(key, window_idx, desc_path), ...], ascending desc_path then window_idx (deterministic). Empty when the
        query has no view vec. The radius is padded by a tiny epsilon so a point sitting EXACTLY on view_max is
        never dropped by BallTree's BLAS summation order differing from viewpoint_dist's pure-Python sqrt (the
        float-boundary gap Codex found). The caller (select_partner) re-applies the EXACT `viewpoint_dist <=
        view_max` gate, which is the authority — so the final pool is exactly the linear-scan set, and a tiny
        false-add here is trimmed there (the tree is a fast retriever, not the membership oracle)."""
        if self.tree is None or not qvec or len(qvec) < 4:
            return []
        emb = np.asarray([viewpoint_embed(qvec)], dtype=float)
        r = float(radius) * (1.0 + 1e-9) + 1e-9   # pad >> 4-D float64 ULP error; exact membership re-checked by caller
        rows = self.tree.query_radius(emb, r=r)[0]
        out = [self.refs[i] for i in rows]
        out.sort(key=lambda r: (r[2], r[1]))   # deterministic, reproducible iteration order
        return out


def _signature(index_dir):
    # Cache key: (name, size, mtime_ns, ctime_ns) per file. A rebuild is forced whenever ANY of them changes.
    # mtime_ns catches every normal whole-file rewrite (all pipeline writers — describe_clip/enrich_full_swing/
    # recompute_viewpoint — do whole-file write_text, so they always bump it); size catches most in-place edits.
    # ctime_ns (inode-change time) closes the residual stale-cache DROP Codex round-2 named: ctime is bumped by
    # the OS on ANY write and CANNOT be forged from userspace — no syscall sets it; utime() sets only atime/mtime;
    # cp -p / rsync --archive restore mtime but ctime becomes "now". So "same path+size+mtime_ns+ctime_ns, changed
    # content" is not producible by hand-edit, metadata-preserving restore, rsync, or utime rollback. The DROP path
    # is structurally closed WITHOUT hashing bytes every call (that would be O(total) per query and defeat the cache).
    files = sorted(glob.glob(str(Path(index_dir) / "*.desc.json")))
    out = []
    for f in files:
        st = Path(f).stat()
        out.append((f, st.st_size, st.st_mtime_ns, st.st_ctime_ns))
    return tuple(out)


def _finite4(p):
    return len(p) == 4 and all(isinstance(x, (int, float)) and x == x and x not in (float("inf"), float("-inf")) for x in p)


def get_index(index_dir):
    """Build (or return cached) the viewpoint index for `index_dir`. O(total) once; O(log n + k) per query after.
    Robust to a malformed descriptor: a window whose vec cannot embed to 4 finite floats is SKIPPED (like the old
    per-window scan), never crashing the whole build. Correctness of membership does NOT rest on this index — the
    caller re-applies the exact viewpoint_dist gate — so a skipped/stale window can only be a fast-path miss that
    the exact gate still resolves against the CURRENT descriptor."""
    index_dir = str(index_dir)
    sig = _signature(index_dir)
    cached = _CACHE.get(index_dir)
    if cached and cached[0] == sig:
        return cached[1]
    refs = []
    pts = []
    total = 0
    skipped_json = 0          # desc files that would not parse (counted + surfaced, never silently lost — round-2 #5)
    skipped_window = 0        # windows with a malformed/non-finite view vec
    for f in sorted(glob.glob(str(Path(index_dir) / "*.desc.json"))):
        try:
            rec = FJ.load_text(f)             # #198.1: reject a non-finite descriptor (NonFiniteJSON ⊂ ValueError)…
        except (ValueError, OSError):         # …malformed/non-finite JSON / unreadable file. NARROW (was bare Exception):
            skipped_json += 1                 # a poisoned descriptor is dropped from the index (fail-closed), real bugs crash.
            continue
        key = Path(f).stem.replace(".desc", "")
        for i, w in enumerate(rec.get("windows", [])):
            total += 1
            v = (w.get("viewpoint") or {}).get("vec")
            if not v or len(v) < 4:
                continue                      # no view vec -> viewpoint_dist would return 1.0 (>view_max) anyway
            try:
                emb = viewpoint_embed(v)
            except (TypeError, ValueError):   # NON-numeric vec only. NARROW (was bare Exception): an AttributeError/
                skipped_window += 1           # NameError introduced by a future refactor now crashes (fail-stop)
                continue                      # rather than being swallowed and quietly shrinking the index.
            if not _finite4(emb):
                skipped_window += 1
                continue
            refs.append((key, i, f))
            pts.append(emb)
    if skipped_json or skipped_window:        # diagnostics must not lie by omission (Codex round-2 #5)
        print(f"[viewpoint_index] {index_dir}: skipped {skipped_json} unparseable desc file(s), "
              f"{skipped_window} malformed window(s) of {total} (fail-closed: lowers recall, never a wrong match)",
              file=sys.stderr)
    tree = BallTree(np.asarray(pts, dtype=float), metric="euclidean") if pts else None
    vi = ViewpointIndex(tree, refs, total, skipped_json, skipped_window)
    _CACHE[index_dir] = (sig, vi)
    return vi
