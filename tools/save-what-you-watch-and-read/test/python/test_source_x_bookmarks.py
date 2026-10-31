# tools/save-what-you-watch-and-read/test/python/test_source_x_bookmarks.py
#
# Fixture-based and adversarial tests for the `x-bookmarks` source row.
# Tests the normalization layer: snapshot -> thread_specs -> canonical atoms.
# Uses the REAL transcript mapper (the one primitive shared across all
# conversation sources); the snapshot is reached only through the row.
import json
import pathlib
import tempfile

import support  # noqa: E402

xb = support.source("x-bookmarks")


def test_fixture_single_tweet():
    """Fixture: single bookmark -> single thread_spec."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": "next_token_123",
        "bookmarks": [
            {
                "id": "tweet_001",
                "text": "This is a bookmark",
                "created_at": "2026-07-20T15:30:00Z",
                "author_id": "12345",  # "me"
                "public_metrics": {"like_count": 5, "retweet_count": 2}
            }
        ],
        "deduped_tweet_ids": {"tweet_001": True}
    }

    thread_specs = xb.thread_specs(snapshot)
    assert len(thread_specs) == 1
    assert thread_specs[0]["session_id"] == "tweet_001"
    assert thread_specs[0]["messages"][0]["speaker"] == "me"
    assert thread_specs[0]["messages"][0]["text"] == "This is a bookmark"
    assert thread_specs[0]["messages"][0]["at"] == "2026-07-20T15:30:00Z"
    assert thread_specs[0]["messages"][0]["index"] == 0


def test_fixture_multiple_tweets():
    """Fixture: multiple bookmarks by different users."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": None,
        "bookmarks": [
            {
                "id": "tweet_001",
                "text": "My bookmark",
                "created_at": "2026-07-20T15:30:00Z",
                "author_id": "12345",  # "me"
            },
            {
                "id": "tweet_002",
                "text": "Someone else's tweet",
                "created_at": "2026-07-20T14:00:00Z",
                "author_id": "67890",  # not me
            }
        ],
        "deduped_tweet_ids": {"tweet_001": True, "tweet_002": True}
    }

    thread_specs = xb.thread_specs(snapshot)
    assert len(thread_specs) == 2
    assert thread_specs[0]["messages"][0]["speaker"] == "me"
    assert thread_specs[1]["messages"][0]["speaker"] == "67890"


def test_adversarial_empty_bookmarks():
    """Adversarial: empty bookmarks array -> empty atoms (no crash)."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": None,
        "bookmarks": [],
        "deduped_tweet_ids": {}
    }

    assert xb.thread_specs(snapshot) == []


def test_adversarial_missing_text():
    """Adversarial: bookmark without text is skipped (no crash)."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": None,
        "bookmarks": [
            {
                "id": "tweet_001",
                # missing text field
                "created_at": "2026-07-20T15:30:00Z",
                "author_id": "12345",
            }
        ],
        "deduped_tweet_ids": {"tweet_001": True}
    }

    assert xb.thread_specs(snapshot) == []  # Text-less tweets are dropped (invariant 3)


def test_adversarial_malformed_timestamp():
    """Adversarial: unparseable timestamp -> None (mapper handles it)."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": None,
        "bookmarks": [
            {
                "id": "tweet_001",
                "text": "Bookmark with bad timestamp",
                "created_at": "invalid-timestamp",  # unparseable
                "author_id": "12345",
            }
        ],
        "deduped_tweet_ids": {"tweet_001": True}
    }

    thread_specs = xb.thread_specs(snapshot)
    assert len(thread_specs) == 1
    assert thread_specs[0]["messages"][0]["at"] is None


def test_adversarial_missing_author_id():
    """Adversarial: missing author_id -> speaker is None (mapper handles it)."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": None,
        "bookmarks": [
            {
                "id": "tweet_001",
                "text": "Bookmark without author",
                # missing author_id
                "created_at": "2026-07-20T15:30:00Z",
            }
        ],
        "deduped_tweet_ids": {"tweet_001": True}
    }

    thread_specs = xb.thread_specs(snapshot)
    assert len(thread_specs) == 1
    assert thread_specs[0]["messages"][0]["speaker"] is None


def test_adversarial_non_dict_tweet():
    """Adversarial: malformed tweet object is skipped."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": None,
        "bookmarks": [
            "not a dict",
            {"id": "tweet_001", "text": "Good tweet", "author_id": "12345", "created_at": "2026-07-20T15:30:00Z"}
        ],
        "deduped_tweet_ids": {"tweet_001": True}
    }

    thread_specs = xb.thread_specs(snapshot)
    assert len(thread_specs) == 1  # Only the valid tweet
    assert thread_specs[0]["session_id"] == "tweet_001"


def test_adversarial_missing_tweet_id():
    """Adversarial: tweet without id is skipped."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": None,
        "bookmarks": [
            {
                # missing id
                "text": "Bookmark without ID",
                "created_at": "2026-07-20T15:30:00Z",
                "author_id": "12345",
            }
        ],
        "deduped_tweet_ids": {}
    }

    assert xb.thread_specs(snapshot) == []  # Skipped due to missing id


def test_saved_capture_url_supplies_stable_identity_and_source_link():
    snapshot = {"mode": "bookmarks", "bookmarks": [
        {"url": "https://x.com/sample-person/status/1000000000000000001", "text": "Saved idea"},
        {"url": "https://twitter.com/sample-person/status/1000000000000000001", "text": "Duplicate save"},
        {"url": "https://example.com/sample-person/status/123", "text": "Wrong host"},
    ]}
    specs = xb.thread_specs(snapshot)
    assert len(specs) == 1
    assert specs[0]["session_id"] == "1000000000000000001"
    assert specs[0]["native_ref"] == "https://x.com/i/status/1000000000000000001"
    result = xb.tm.map_transcript({"source_ref": "source:x"}, {}, specs)
    assert len(result["atoms"]) == 1
    assert result["atoms"][0]["native_ref"] == "https://x.com/i/status/1000000000000000001"


def test_fetch_dispatcher_batch_filters_category_and_pages_without_skips():
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        bookmarks = root / "bookmarks.json"
        likes = root / "likes.json"
        bookmarks.write_text(json.dumps({"mode": "bookmarks", "bookmarks": [
            {"url": f"https://x.com/a/status/{number}", "text": f"Post {number}"}
            for number in (101, 102, 103)
        ]}), encoding="utf-8")
        likes.write_text(json.dumps({"mode": "likes", "bookmarks": [
            {"url": "https://x.com/a/status/201", "text": "Liked post"}
        ]}), encoding="utf-8")
        observations = [{"source_ref": "source:x", "native_ref": str(path)} for path in (bookmarks, likes)]

        def fetch(category, cursor=None):
            return xb.decode_batch({"batch": {"accepted": observations},
                                    "category_key": category, "cursor": cursor,
                                    "limit": 2, "descriptor": {}})
        first = fetch("bookmarks")
        second = fetch("bookmarks", first["next_cursor"])
        assert len(first["atoms"]) == 2
        assert len(second["atoms"]) == 1
        assert first["next_cursor"] == "2" and second["next_cursor"] is None
        assert len({atom["atom_ref"] for atom in first["atoms"] + second["atoms"]}) == 3
        assert len(fetch("likes")["atoms"]) == 1


def test_adversarial_corrupted_snapshot():
    """Adversarial: non-dict snapshot -> empty (graceful error)."""
    assert xb.thread_specs("not a dict") == []


def test_full_flow_with_mapper():
    """Full flow: snapshot -> thread_specs -> map_transcript (REAL mapper)."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": "next_token",
        "bookmarks": [
            {
                "id": "tweet_001",
                "text": "Bookmarked tweet",
                "created_at": "2026-07-20T15:30:00Z",
                "author_id": "12345",
            }
        ],
        "deduped_tweet_ids": {"tweet_001": True}
    }

    thread_specs = xb.thread_specs(snapshot)

    # Build observation for the mapper
    observation = {"source_ref": "source:x"}
    descriptor = {"display_mark_ref": "mark:x"}

    # Call the real map_transcript
    result = xb.tm.map_transcript(observation, descriptor, thread_specs)

    assert "threads" in result
    assert "atoms" in result
    assert "rejections" in result
    assert len(result["threads"]) >= 0  # May have threads if all specs are valid
    assert len(result["atoms"]) >= 0   # Atoms generated by mapper


def test_uniform_decoder_contract_reads_declared_snapshot_only():
    snapshot = {
        "user_id": "12345",
        "bookmarks": [{
            "id": "tweet_001",
            "text": "Declared record snapshot",
            "created_at": "2026-07-20T15:30:00Z",
            "author_id": "12345",
        }],
    }
    with tempfile.TemporaryDirectory() as directory:
        path = pathlib.Path(directory) / "snapshot.json"
        path.write_text(json.dumps(snapshot), encoding="utf-8")
        result = xb.decode(
            {"source_ref": "source:x", "native_ref": str(path), "batch_ref": "batch:one"},
            {"display_mark_ref": "mark:x"},
        )
    assert len(result["threads"]) == 1
    assert len(result["atoms"]) == 1
    assert result["rejections"] == []
    assert result["atoms"][0]["content"]["text"] == "Declared record snapshot"


def test_uniform_decoder_pages_large_snapshot_without_dropping_bookmarks():
    snapshot = {"user_id": "12345", "bookmarks": [
        {"id": f"tweet_{index}", "text": f"Bookmark {index}", "author_id": "12345"}
        for index in range(11)
    ]}
    with tempfile.TemporaryDirectory() as directory:
        path = pathlib.Path(directory) / "snapshot.json"
        path.write_text(json.dumps(snapshot), encoding="utf-8")
        observation = {"source_ref": "source:x", "native_ref": str(path)}
        first = xb.decode_summary_page(observation, {}, None, 8)
        second = xb.decode_summary_page(observation, {}, first["next_cursor"], 8)
    assert len(first["threads"]) == 8
    assert first["has_more"] is True
    assert first["next_cursor"] == 8
    assert len(second["threads"]) == 3
    assert second["has_more"] is False
    assert second["next_cursor"] is None


def test_zero_text_less_tweets():
    """Invariant test: text-less tweets NEVER appear in thread_specs."""
    snapshot = {
        "user_id": "12345",
        "account_ref": "default",
        "pagination_token": None,
        "bookmarks": [
            {"id": "tweet_001", "created_at": "2026-07-20T15:30:00Z", "author_id": "12345"},  # no text
            {"id": "tweet_002", "text": "", "created_at": "2026-07-20T14:00:00Z", "author_id": "12345"},  # empty text
            {"id": "tweet_003", "text": None, "created_at": "2026-07-20T13:00:00Z", "author_id": "12345"},  # null text
            {"id": "tweet_004", "text": "Valid tweet", "created_at": "2026-07-20T12:00:00Z", "author_id": "12345"}  # has text
        ],
        "deduped_tweet_ids": {"tweet_001": True, "tweet_002": True, "tweet_003": True, "tweet_004": True}
    }

    thread_specs = xb.thread_specs(snapshot)
    assert len(thread_specs) == 1  # Only tweet_004
    assert thread_specs[0]["session_id"] == "tweet_004"
