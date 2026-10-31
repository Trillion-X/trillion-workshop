# tools/conversations/test/python/test_snapshot_fold.py
#
# Offline proof of the shared snapshot fold: the three conflict policies, dedup idempotence, rename and sort.
import support  # noqa: E402,F401  (read-data on the import path)

import snapshot_fold as fold  # noqa: E402


def _key(message):
    return str(message["id"])


def _sort(message):
    return int(message["id"])


def _stamp(message):
    return int(message.get("edit", 0))


def test_upsert_creates_a_thread_with_a_text_id_and_a_title():
    threads = []
    assert fold.upsert_thread(threads, 5, title="Room") == {"id": "5", "title": "Room", "messages": []}


def test_upsert_returns_the_same_thread_on_a_re_fold_and_carries_a_rename():
    threads = []
    first = fold.upsert_thread(threads, 5, title="Room")
    again = fold.upsert_thread(threads, "5", title="Renamed")
    assert again is first and first["title"] == "Renamed" and len(threads) == 1
    assert fold.upsert_thread(threads, "5")["title"] == "Renamed"        # no title given: kept


def test_upsert_defaults_the_title_to_the_id():
    assert fold.upsert_thread([], 9)["title"] == "9"


def test_fold_sorts_chronologically_and_a_re_fold_of_the_same_messages_does_not_grow():
    messages = []
    for _ in range(2):
        fold.fold_messages(messages, [{"id": "2", "e": 0}, {"id": "1", "e": 0}],
                           message_key=_key, sort_key=_sort, resolve_conflict=fold.field_merge)
        assert [m["id"] for m in messages] == ["1", "2"]


def test_field_merge_keeps_earlier_only_fields_and_overwrites_with_incoming():
    messages = []
    fold.fold_messages(messages, [{"id": "1", "text": "hi", "seen": False}],
                       message_key=_key, sort_key=_sort, resolve_conflict=fold.field_merge)
    fold.fold_messages(messages, [{"id": "1", "seen": True}],
                       message_key=_key, sort_key=_sort, resolve_conflict=fold.field_merge)
    assert messages[0] == {"id": "1", "text": "hi", "seen": True}


def test_keep_newer_by_replaces_on_a_tie_when_not_strict():
    policy = fold.keep_newer_by(_stamp, strict=False)
    assert policy({"id": "1", "edit": 1}, {"id": "1", "edit": 2}) == {"id": "1", "edit": 2}
    assert policy({"id": "1", "edit": 5, "old": True}, {"id": "1", "edit": 5}) == {"id": "1", "edit": 5}
    assert policy({"id": "1", "edit": 3}, {"id": "1", "edit": 1}) == {"id": "1", "edit": 3}      # never a downgrade


def test_keep_newer_by_keeps_what_is_stored_on_a_tie_when_strict():
    policy = fold.keep_newer_by(_stamp, strict=True)
    assert policy({"id": "1", "edit": 1}, {"id": "1", "edit": 2}) == {"id": "1", "edit": 2}
    assert policy({"id": "1", "edit": 5, "old": True}, {"id": "1", "edit": 5}) == {"id": "1", "edit": 5, "old": True}
    assert policy({"id": "1", "edit": 3}, {"id": "1", "edit": 1}) == {"id": "1", "edit": 3}


def test_entries_that_are_not_messages_are_skipped_and_none_is_an_empty_fold():
    messages = [{"id": "1"}]
    fold.fold_messages(messages, [None, "x", {"id": "2"}],
                       message_key=_key, sort_key=_sort, resolve_conflict=fold.field_merge)
    assert [m["id"] for m in messages] == ["1", "2"]
    assert fold.fold_messages(messages, None, message_key=_key, sort_key=_sort,
                              resolve_conflict=fold.field_merge) is messages


def test_a_pile_with_no_order_keeps_the_order_the_source_gave():
    messages = []
    fold.fold_messages(messages, [{"id": "9"}, {"id": "3"}], message_key=_key, sort_key=None,
                       resolve_conflict=fold.field_merge)
    fold.fold_messages(messages, [{"id": "5"}, {"id": "9", "extra": 1}], message_key=_key, sort_key=None,
                       resolve_conflict=fold.field_merge)
    assert [m["id"] for m in messages] == ["9", "3", "5"] and messages[0]["extra"] == 1
