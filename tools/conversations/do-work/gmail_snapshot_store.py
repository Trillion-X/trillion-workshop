#!/usr/bin/env python3
# packages/gmail-mailbox-decoder/do-work/gmail_snapshot_store.py
#
# Purpose: Pure (offline, dependency-free) deduplication + snapshot-merge logic
# for Gmail message fetches. The producer (connect-gmail.py) calls this to avoid
# re-processing messages or losing cursor position on partial fetches.
#
# This module owns NO network, NO I/O (except what the caller passes), NO
# credentials. It is a pure FOLD over fetched message updates.
#
# The fold itself is NOT written here. `conversation-snapshot-fold` owns the one
# "merge a freshly pulled page into the pile without duplicates" shape that every
# connector needs, and it is delivered here as a co-mounted sibling exactly the
# way the other connectors receive it. What stays here is only the part that is
# actually about mail: which field is the identity, how entries are ordered, that
# the copy already held wins a collision, and how the position cursor advances.
#
# Non-Negotiable Invariants:
# - Pure: no side effects, no network, no I/O. A test can call this offline.
# - Idempotent: folding the same batch twice produces the same result.
# - Monotonic: historyId/cursor only advances, never regresses.
# - No overwrite: a message already seen is never re-folded; merge is additive.
# - The caller's lists are never mutated; the shared fold works on a copy.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "read-data"))
import snapshot_fold as csf  # noqa: E402  (the shared fold, read-data/snapshot_fold.py)


def merge_snapshot(existing_messages, new_messages, dedup_by="id"):
    """
    Merge a batch of new messages with existing snapshot, deduplicating by
    message id. Returns merged messages in stable order (by id).

    The merging is done by the shared fold. The three things that are actually
    about mail are passed to it as functions: what counts as the identity, how
    to order the result, and which copy wins when two share an identity.

    Args:
        existing_messages: list of message objects (or empty list)
        new_messages: list of message objects from the latest fetch
        dedup_by: field to deduplicate on (default "id")

    Returns:
        list of merged, deduplicated messages (sorted by dedup_by for stability)
    """
    def identity(message):
        return message.get(dedup_by)

    def in_order(message):
        return str(message.get(dedup_by, ""))

    def the_copy_already_held_wins(existing, incoming):
        return existing

    # An entry with no identity has never been foldable and is still dropped.
    kept = [m for m in (existing_messages or [])
            if isinstance(m, dict) and identity(m)]
    arriving = [m for m in (new_messages or [])
                if isinstance(m, dict) and identity(m)]

    return csf.fold_messages(
        list(kept), arriving,
        message_key=identity,
        sort_key=in_order,
        resolve_conflict=the_copy_already_held_wins,
    )


def advance_cursor(current_history_id, new_history_id):
    """
    Advance the history cursor monotonically. If new_history_id is lexically
    greater (as a string, since Gmail uses numeric string ids), advance; else
    keep current (fail closed, never regress).

    Args:
        current_history_id: current cursor (string or None)
        new_history_id: proposed new cursor (string or None)

    Returns:
        the advanced cursor (string)
    """
    if not current_history_id:
        return new_history_id or "1"
    if not new_history_id:
        return current_history_id

    try:
        curr_num = int(current_history_id)
        new_num = int(new_history_id)
        return str(max(curr_num, new_num))
    except (ValueError, TypeError):
        # Fallback to lexical comparison if not pure integers
        return new_history_id if (new_history_id > current_history_id) else current_history_id
