#!/usr/bin/env python3
# packages/instagram-dm-connector/do-work/ig_snapshot_store.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# PURE core of the Instagram DM connector: fold instagrapi `direct_threads()`
# pulls into the durable, deduplicated snapshot the `instagram-dm-decoder` reads.
# Instagram is a PULL source (each fetch returns full thread state, not a stream),
# so a "batch" is a list of thread dicts, and folding = union threads by id + union
# messages by item id, so re-pulling never loses earlier history and never
# double-counts. Output is the decoder's input contract VERBATIM:
#   { "self_pk": <id|None>, "threads": [ <DirectThread .dict()>, ... ] }
#
# This is the SAME primitive as the WhatsApp `wa-snapshot-store` (acquisition
# adapter: authenticated source -> deduplicated snapshot), configured for the
# instagrapi pull shape. It is I/O-free, network-free, instagrapi-free — fully
# offline-testable — so the connector is not a god package: it owns ONLY the
# pull-into-snapshot reconciliation. Login/session/send live in the live shell.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
# 1. NO NETWORK, NO instagrapi IMPORT. Pure dict-in / dict-out.
# 2. DEDUP by structural identity (item id), never by position — a re-pull that
#    returns the same messages must not grow the snapshot.
# 3. MERGE, never overwrite — union of all threads/messages ever seen.
# 4. Branch on SHAPE, never on source name (L090).
#
# The per-thread message dedup/resolve/sort is the SHARED fold primitive,
# co-mounted beside this store as `conversation_snapshot_fold` (never imported
# across packages) and reused here for the message half; IG keeps its own richer
# thread upsert (users / viewer_id / thread_title) below.
import copy
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'conversations', 'read-data'))
import snapshot_fold as csf  # noqa: E402  (the conversations tool's fold)


def empty_snapshot(self_pk=None):
    """Fresh snapshot for a viewer (self_pk = our instagram user id, if known)."""
    return {"self_pk": str(self_pk) if self_pk is not None else None, "threads": []}


def _first(d, *keys):
    for k in keys:
        v = d.get(k) if isinstance(d, dict) else None
        if v is not None and v != "":
            return v
    return None


def thread_id(thread):
    """Stable thread identity — the instagrapi DirectThread id."""
    return _first(thread, "id", "thread_id", "pk", "thread_v2_id")


def message_key(msg):
    """Stable per-message identity. instagrapi stamps `item_id`; fall back to
    `id`, else a content signature (user+timestamp+text) so keyless items still
    dedup deterministically instead of piling up on every re-pull."""
    k = _first(msg, "item_id", "id")
    if k is not None:
        return str(k)
    sig = "{}|{}|{}".format(
        _first(msg, "user_id", "sender_id") or "",
        _first(msg, "timestamp", "created_at", "at") or "",
        (msg.get("text") or "")[:120] if isinstance(msg, dict) else "",
    )
    return "sig:" + sig


def _messages_of(thread):
    return thread.get("messages") or thread.get("items") or []


def _ts_of(msg):
    """Sort key — tolerate micros/millis/secs; missing -> 0 (stable, sorts first)."""
    v = _first(msg, "timestamp", "created_at", "at")
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        # ISO or numeric string; best-effort numeric, else keep insertion order via 0.
        try:
            return float(v)
        except ValueError:
            return 0.0
    return 0.0


def _merge_users(existing, incoming):
    """Union thread members by user id (later fields win — usernames can change)."""
    by_id = {}
    for u in list(existing or []) + list(incoming or []):
        if not isinstance(u, dict):
            continue
        uid = _first(u, "pk", "id", "user_id")
        if uid is None:
            continue
        by_id[str(uid)] = {**by_id.get(str(uid), {}), **u}
    return list(by_id.values())


def _merge_one_thread(existing, incoming):
    """Fold one freshly-pulled thread onto the accumulated one: union messages by
    key (incoming fields win — edits/reactions update), union users, keep the
    richest title/viewer, chronological message order."""
    merged = copy.deepcopy(existing) if existing else {}
    for field in ("id", "thread_id", "pk", "thread_v2_id", "thread_title", "viewer_id"):
        if _first(incoming, field) is not None:
            merged[field] = incoming[field]
    merged["users"] = _merge_users(existing.get("users") if existing else None,
                                   incoming.get("users") or incoming.get("members"))
    # Message half via the shared fold: dedup by item id, field-merge on collision
    # (instagrapi re-pulls return full current messages), chronological order.
    merged["messages"] = list(_messages_of(existing) if existing else [])
    csf.fold_messages(
        merged["messages"], _messages_of(incoming),
        message_key=message_key, sort_key=_ts_of, resolve_conflict=csf.field_merge,
    )
    return merged


def merge_threads(snapshot, thread_dicts, self_pk=None):
    """Fold a `direct_threads()` pull (list of thread dicts) onto the snapshot.
    Returns a NEW snapshot (immutable). Dedups threads by id and messages by key;
    a re-pull of unchanged threads yields an equal snapshot."""
    out = copy.deepcopy(snapshot) if snapshot else empty_snapshot(self_pk)
    if self_pk is not None:
        out["self_pk"] = str(self_pk)
    by_id = {}
    order = []
    for t in out.get("threads", []):
        tid = str(thread_id(t))
        by_id[tid] = t
        order.append(tid)
    for t in (thread_dicts or []):
        if not isinstance(t, dict):
            continue
        tid = thread_id(t)
        if tid is None:
            continue
        tid = str(tid)
        if tid not in by_id:
            order.append(tid)
        by_id[tid] = _merge_one_thread(by_id.get(tid), t)
    out["threads"] = [by_id[tid] for tid in order]
    return out
