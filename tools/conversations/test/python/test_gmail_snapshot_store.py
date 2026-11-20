#!/usr/bin/env python3
# tools/conversations/test/python/test_gmail_snapshot_store.py (was do-work/__tests__/*.py.held, port of the gmail-mailbox-decoder test)
#
# Characterization tests written BEFORE this store adopted the shared fold, so
# they describe the behavior that existed and must survive the adoption:
# existing wins on a collision, ordering is by the dedup field as text, entries
# without that field are dropped, and folding twice changes nothing.
#
# Run: python3 tools/conversations/test/python/test_gmail_snapshot_store.py   (exit 0 = pass)

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DO_WORK = os.path.join(HERE, "..", "..", "do-work")

spec = importlib.util.spec_from_file_location(
    "gmail_snapshot_store", os.path.join(DO_WORK, "gmail_snapshot_store.py"))
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


def test_new_entries_are_added():
    out = store.merge_snapshot([{"id": "1"}], [{"id": "2"}])
    assert [m["id"] for m in out] == ["1", "2"], out


def test_the_one_already_kept_wins_a_collision():
    out = store.merge_snapshot([{"id": "1", "subject": "kept"}],
                               [{"id": "1", "subject": "arrived later"}])
    assert out == [{"id": "1", "subject": "kept"}], out


def test_order_is_by_the_dedup_field_as_text():
    out = store.merge_snapshot([{"id": "10"}, {"id": "2"}], [{"id": "1"}])
    assert [m["id"] for m in out] == ["1", "10", "2"], out


def test_an_entry_without_the_field_is_dropped():
    out = store.merge_snapshot([{"nope": "x"}], [{"id": "1"}, {"also": "no"}])
    assert out == [{"id": "1"}], out


def test_folding_twice_changes_nothing():
    once = store.merge_snapshot([], [{"id": "1"}, {"id": "2"}])
    twice = store.merge_snapshot(once, [{"id": "1"}, {"id": "2"}])
    assert once == twice, (once, twice)


def test_the_inputs_are_not_mutated():
    existing = [{"id": "1"}]
    incoming = [{"id": "2"}]
    store.merge_snapshot(existing, incoming)
    assert existing == [{"id": "1"}] and incoming == [{"id": "2"}]


def test_a_different_dedup_field_is_honoured():
    out = store.merge_snapshot([{"thread": "a"}], [{"thread": "a"}, {"thread": "b"}],
                               dedup_by="thread")
    assert [m["thread"] for m in out] == ["a", "b"], out


def test_empty_and_none_are_both_accepted():
    assert store.merge_snapshot(None, None) == []
    assert store.merge_snapshot([], []) == []


def test_the_cursor_only_moves_forward():
    assert store.advance_cursor("10", "9") == "10"
    assert store.advance_cursor("9", "10") == "10"
    assert store.advance_cursor(None, "5") == "5"
    assert store.advance_cursor("5", None) == "5"
    assert store.advance_cursor(None, None) == "1"


def main():
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print("PASS " + test.__name__)
    print("")
    print(str(len(tests)) + "/" + str(len(tests)) + " gmail snapshot store tests pass")


if __name__ == "__main__":
    main()
