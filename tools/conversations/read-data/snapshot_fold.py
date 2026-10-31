#!/usr/bin/env python3
# tools/conversations/read-data/snapshot_fold.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# The PURE, generic fold every messaging connector's snapshot store shares. A connector pulls or streams messages from
# an authenticated source and must reconcile them into a durable, deduplicated per-thread snapshot (the file the
# readers of this folder decode) WITHOUT losing earlier history and WITHOUT double-counting on a re-pull. That
# reconciliation is ONE shape:
#
#     find-or-create the thread  ->  dedup incoming messages by a stable key  ->
#     resolve key collisions by the caller's policy  ->  keep chronological order
#
# What differs from one source to the next is not a branch here; it is three functions the caller injects:
#   * message_key(msg)   -> the message's stable identity (item id, message id, snowflake, content signature)
#   * sort_key(msg)      -> its chronological ordering key
#   * resolve_conflict(existing, incoming) -> the message to KEEP when two share a key. Three policies come with it:
#                           `field_merge` (a re-pull returns the full current message), `keep_newer_by(..., strict=False)`
#                           (a newer edit replaces, a tie replaces) and `keep_newer_by(..., strict=True)` (a newer edit
#                           replaces, a tie keeps what is stored).
#
# This file does no I/O, no network, takes no credential and imports no source's SDK, so it is tested offline and a
# connector that packs it runs on its own.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
# 1. NO NETWORK, NO CREDENTIALS, NO SOURCE SDK. Plain dicts and lists in, the same out.
# 2. DEDUP by the caller's structural key, never by position: folding the same message twice does not grow the
#    thread.
# 3. MERGE, never overwrite: a collision is resolved by the caller's policy, and messages that do not collide
#    accumulate (the union of every message ever seen).
# 4. Branch on SHAPE through the injected functions, never on a source's name.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
# =============================================================================


def upsert_thread(threads, thread_id, title=None):
    """Find-or-create the thread with `thread_id` in the mutable `threads` list and return it. On first sight the
    thread is created as `{"id": <str thread_id>, "title": <title or str id>, "messages": []}`; on a re-fold a truthy
    `title` refreshes the stored title, so a rename propagates.

    A source whose threads carry a richer shape (people, a viewer id, an explicit title) keeps its own thread upsert
    and reuses only `fold_messages` below for the message half."""
    tid = str(thread_id)
    for thread in threads:
        if isinstance(thread, dict) and str(thread.get("id")) == tid:
            if title:
                thread["title"] = title
            return thread
    created = {"id": tid, "title": title or tid, "messages": []}
    threads.append(created)
    return created


def fold_messages(messages, incoming, *, message_key, sort_key, resolve_conflict):
    """Fold `incoming` into the `messages` list IN PLACE and return it.

    * Dedup by `message_key(msg)`. A message whose key is unseen is appended; a message whose key already exists is
      reconciled by `resolve_conflict(existing, incoming)`, which returns the message to KEEP.
    * After folding, `messages` is sorted by `sort_key(msg)`, so the transcript is chronological whatever order the
      pull or stream arrived in. Pass `sort_key=None` when the pile has no order of its own: a bookmark list is kept
      in the order the source hands it over, and sorting it every time a page arrives buys nothing. Ordering is the
      caller's property, not this file's assumption.

    Entries of `incoming` that are not dicts are skipped. `messages` is mutated (the caller owns snapshot
    immutability, by copying before it folds), which is why this returns the list it was given."""
    by_key = {}
    for position, message in enumerate(messages):
        if isinstance(message, dict):
            by_key[message_key(message)] = position
    for message in incoming or []:
        if not isinstance(message, dict):
            continue
        key = message_key(message)
        if key in by_key:
            messages[by_key[key]] = resolve_conflict(messages[by_key[key]], message)
        else:
            by_key[key] = len(messages)
            messages.append(message)
    if sort_key is not None:
        messages.sort(key=sort_key)
    return messages


def field_merge(existing, incoming):
    """Shallow-merge fields, incoming wins: a re-pull returns the full current message, so later fields (edits,
    reactions, read state) overwrite while fields only the earlier copy had are kept."""
    return {**existing, **incoming}


def keep_newer_by(edit_stamp, *, strict):
    """A policy factory: replace the stored message with `incoming` only when its edit recency (by
    `edit_stamp(msg)`) is newer, so an edit is shown but never downgraded back to the original.

    `strict=False` replaces on a tie too (the incoming copy of an equally stamped message wins); `strict=True` keeps
    the stored copy on a tie."""
    def resolve(existing, incoming):
        if strict:
            return incoming if edit_stamp(incoming) > edit_stamp(existing) else existing
        return incoming if edit_stamp(incoming) >= edit_stamp(existing) else existing
    return resolve
