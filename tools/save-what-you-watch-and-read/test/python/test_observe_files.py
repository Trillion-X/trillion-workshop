# tools/save-what-you-watch-and-read/test/python/test_observe_files.py
#
# Proves observe_files.py over a made-up folder: a pattern finds matching files; a re-run with the last answer's
# `next_since` finds nothing until a file changes; `most` cuts newest first and says there is more; a window opens no
# file; a link that leaves the folder is skipped and named, never followed; paths that leave the folder are refused;
# accounts are found by a folder-name prefix; `with_hash` gives a content identity within its size bound.
import os
import pathlib
import tempfile

import support  # noqa: E402,F401  (read-data on the import path)

import observe_files as of  # noqa: E402
from content_identity import content_hash  # noqa: E402


def _folder(files):
    root = pathlib.Path(tempfile.mkdtemp(prefix="observe-files-"))
    for name, body, mtime in files:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        os.utime(path, (mtime, mtime))
    return root


BAKERY = [
    ("orders/2026-01.jsonl", b"rye\n", 1_700_000_100),
    ("orders/2026-02.jsonl", b"sourdough\n", 1_700_000_200),
    ("orders/2026-03.jsonl", b"focaccia\n", 1_700_000_300),
    ("notes/readme.txt", b"hello\n", 1_700_000_400),
]


def _refused(folder, request, words):
    try:
        of.observe(str(folder), request)
    except of.Refusal as refusal:
        assert words in str(refusal), str(refusal)
    else:
        raise AssertionError(f"{request} was not refused")


def test_a_pattern_finds_matching_files_newest_first_with_their_state():
    root = _folder(BAKERY)
    seen = of.observe(str(root), {"source_ref": "source:orders", "glob": "orders/*.jsonl"})
    assert [o["native_ref"] for o in seen["observations"]] == ["orders/2026-03.jsonl", "orders/2026-02.jsonl", "orders/2026-01.jsonl"]
    first = seen["observations"][2]
    assert first["state"] == f"{1_700_000_100 * 10**9}:4"
    assert first["payload"]["size_bytes"] == 4 and first["payload"]["kind"] == "file"
    assert first["content_hash"] is None
    assert seen["more"] is False and seen["skipped"] == []


def test_a_rerun_with_the_last_answer_finds_nothing_until_a_file_changes():
    root = _folder(BAKERY)
    request = {"source_ref": "source:orders", "glob": "orders/*.jsonl"}
    first = of.observe(str(root), request)
    again = of.observe(str(root), {**request, "since": first["next_since"]})
    assert again["observations"] == []
    (root / "orders" / "2026-02.jsonl").write_bytes(b"sourdough and spelt\n")
    third = of.observe(str(root), {**request, "since": first["next_since"]})
    assert [o["native_ref"] for o in third["observations"]] == ["orders/2026-02.jsonl"]


def test_most_cuts_newest_first_and_the_rest_are_still_new_next_time():
    root = _folder(BAKERY)
    request = {"source_ref": "source:orders", "glob": "orders/*.jsonl", "most": 2}
    first = of.observe(str(root), request)
    assert [o["native_ref"] for o in first["observations"]] == ["orders/2026-03.jsonl", "orders/2026-02.jsonl"]
    assert first["more"] is True
    second = of.observe(str(root), {**request, "since": first["next_since"]})
    assert [o["native_ref"] for o in second["observations"]] == ["orders/2026-01.jsonl"]
    assert second["more"] is False


def test_a_window_is_the_newest_files_by_name_and_size_with_no_hash_and_no_next_since():
    root = _folder(BAKERY)
    seen = of.observe(str(root), {"source_ref": "source:all", "window": 2, "with_hash": True})
    assert [o["native_ref"] for o in seen["observations"]] == ["notes/readme.txt", "orders/2026-03.jsonl"]
    assert all(o["content_hash"] is None for o in seen["observations"])
    assert seen["next_since"] is None and seen["more"] is True


def test_a_link_that_leaves_the_folder_is_skipped_and_named_never_followed():
    root = _folder(BAKERY)
    outside = _folder([("secret.txt", b"not yours\n", 1_700_000_500)])
    os.symlink(outside / "secret.txt", root / "orders" / "linked.jsonl")
    os.symlink(outside, root / "orders" / "linked-folder")
    seen = of.observe(str(root), {"source_ref": "source:orders", "glob": "orders/**/*", "include_kinds": ["file", "directory"]})
    refs = [o["native_ref"] for o in seen["observations"]]
    assert "orders/linked.jsonl" not in refs and not any(ref.startswith("orders/linked-folder") for ref in refs)
    assert {item["path"] for item in seen["skipped"]} >= {"orders/linked.jsonl", "orders/linked-folder"}
    assert all("leads out of the folder" in item["why"] for item in seen["skipped"])


def test_a_pattern_or_under_that_leaves_the_folder_is_refused():
    root = _folder(BAKERY)
    _refused(root, {"source_ref": "s", "glob": "../*"}, "glob is a pattern inside the folder")
    _refused(root, {"source_ref": "s", "glob": "/etc/*"}, "glob is a pattern inside the folder")
    _refused(root, {"source_ref": "s", "under": ".."}, "under is outside the folder you granted")
    _refused(root, {"source_ref": "s", "most": 0}, "most is a whole number")
    _refused(root, {"source_ref": "s", "include_kinds": ["socket"]}, "include_kinds is a list")
    _refused(root, {"glob": "*"}, "source_ref is required")


def test_accounts_are_the_folders_whose_name_starts_with_the_prefix():
    root = _folder([
        ("acct-rosa/inbox/a.txt", b"a", 1_700_000_100),
        ("acct-ben/inbox/b.txt", b"b", 1_700_000_200),
        ("other/inbox/c.txt", b"c", 1_700_000_300),
    ])
    seen = of.observe(str(root), {"source_ref": "s", "account_prefix": "acct-", "under_account": "inbox", "glob": "*.txt"})
    assert [(o["native_ref"], o["payload"]["account_dir"], o["payload"]["relative_path"]) for o in seen["observations"]] == [
        ("acct-ben/inbox/b.txt", "acct-ben", "b.txt"), ("acct-rosa/inbox/a.txt", "acct-rosa", "a.txt")]


def test_with_hash_gives_the_content_identity_of_a_file_within_the_bound_and_none_beyond_it():
    root = _folder(BAKERY)
    seen = of.observe(str(root), {"source_ref": "s", "glob": "orders/2026-01.jsonl", "with_hash": True})
    assert seen["observations"][0]["content_hash"] == content_hash(b"rye\n")
    small = of.observe(str(root), {"source_ref": "s", "glob": "orders/2026-01.jsonl", "with_hash": True, "hash_up_to_bytes": 2})
    assert small["observations"][0]["content_hash"] is None


def test_directories_are_observed_only_when_asked_and_are_known_by_their_state():
    root = _folder(BAKERY)
    seen = of.observe(str(root), {"source_ref": "s", "glob": "*", "include_kinds": ["directory"]})
    assert sorted(o["native_ref"] for o in seen["observations"]) == ["notes", "orders"]
    assert all(o["payload"]["kind"] == "directory" and o["payload"]["size_bytes"] is None and o["content_hash"] for o in seen["observations"])


def test_a_folder_that_is_not_a_folder_is_refused():
    _refused("/no/such/folder/anywhere", {"source_ref": "s"}, "not a folder")
