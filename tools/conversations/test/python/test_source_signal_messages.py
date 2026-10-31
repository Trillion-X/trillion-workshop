# tools/conversations/test/python/test_source_signal_messages.py
#
# Tests of the `signal-messages` source row: message normalization and thread
# mapping, read through the one generic reader and the one mapper.
import json
import os
import tempfile

import support  # noqa: E402

signal = support.source("signal-messages")

OWN = "+15550100"


def _norm(message, self_id=OWN):
    return signal.message(message, snapshot_extra={"self_id": self_id})


def test_iso_of_milliseconds():
    """Millisecond to ISO-8601 conversion."""
    # Unix epoch milliseconds (2023-11-14 22:13:20 UTC)
    iso_str = _norm({"id": "m", "timestamp": 1700000000000, "from": "alice", "body": "x"})["at"]
    assert iso_str is not None
    assert iso_str.endswith("Z")
    assert "2023-11-14" in iso_str or "2023-11-15" in iso_str  # Timezone variation


def test_iso_of_invalid():
    """Invalid timestamps give no time."""
    assert _norm({"id": "m", "timestamp": None, "from": "alice", "body": "x"})["at"] is None
    assert _norm({"id": "m", "timestamp": "not a number", "from": "alice", "body": "x"})["at"] is None
    assert _norm({"id": "m", "timestamp": "", "from": "alice", "body": "x"})["at"] is None


def test_norm_message():
    """Message normalization."""
    norm = _norm({
        "id": "msg1",
        "timestamp": 1700000000000,
        "from": "alice",
        "body": "Hello Signal",
        "editedTimestamp": 1700000000500,
    })
    assert norm is not None
    assert norm["speaker"] == "alice"
    assert norm["text"] == "Hello Signal"
    assert norm["at"] is not None  # ISO-8601 timestamp
    assert norm["kind"] == "utterance"


def test_norm_message_me():
    """Own messages are 'me'."""
    norm = _norm({"id": "msg2", "timestamp": 1700000001000, "from": OWN, "body": "My message"})
    assert norm["speaker"] == "me"
    assert norm["text"] == "My message"


def test_norm_message_no_body():
    """Content-less messages carry no text (the mapper drops them)."""
    norm = _norm({"id": "msg3", "timestamp": 1700000002000, "from": "bob"})
    assert norm["text"] is None


def test_thread_spec():
    """Thread spec generation."""
    specs, rejections = signal.thread_result({
        "self_id": OWN,
        "threads": [{
            "id": "thread-1",
            "title": "Test Group",
            "messages": [
                {"id": "msg1", "timestamp": 1700000000000, "from": "alice", "body": "First"},
                {"id": "msg2", "timestamp": 1700000001000, "from": OWN, "body": "Second"},
            ],
        }],
    })
    assert rejections == []  # No rejection
    spec = specs[0]
    assert spec["session_id"] == "thread-1"
    assert spec["title"] == "Test Group"
    assert len(spec["messages"]) == 2
    assert spec["messages"][0]["speaker"] == "alice"
    assert spec["messages"][1]["speaker"] == "me"  # Resolved!


def test_thread_spec_missing_id():
    """A missing thread id is rejected."""
    specs, rejections = signal.thread_result({
        "threads": [{"title": "Broken Thread", "messages": []}],  # Missing "id"
    })
    assert specs == []
    assert len(rejections) == 1
    assert "id" in rejections[0]["violation_path"]


def test_decode_snapshot():
    """Full decode with a snapshot file."""
    snapshot_data = {
        "self_id": OWN,
        "last_timestamp": 1700000001000,
        "threads": [{
            "id": "thread-1",
            "title": "My Chat",
            "messages": [
                {"id": "msg1", "timestamp": 1700000000000, "from": "alice", "body": "Hello"},
                {"id": "msg2", "timestamp": 1700000001000, "from": OWN, "body": "Hi Alice"},
            ],
        }],
    }
    with tempfile.TemporaryDirectory() as folder:
        snapshot_path = os.path.join(folder, "snapshot.json")
        with open(snapshot_path, "w", encoding="utf-8") as f:
            json.dump(snapshot_data, f)
        result = signal.decode({"source_ref": "test", "native_ref": snapshot_path}, None)

    # Verify result shape
    assert "threads" in result
    assert "atoms" in result
    assert "rejections" in result
    assert len(result["atoms"]) == 2  # Both messages have text
    assert result["atoms"][0]["speaker_ref"].endswith(":alice")
    assert result["atoms"][1]["speaker_ref"].endswith(":me")
