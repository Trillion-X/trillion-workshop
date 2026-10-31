# tools/conversations/test/python/test_source_slack_messages.py
#
# Verifies the `slack-messages` source row: message normalization, timestamp
# conversion, speaker resolution and fail-closed semantics. Each assertion reads
# the row through the one generic reader (`support.source(...)`), the way a
# snapshot is read in production.
import json
import pathlib

import support  # noqa: E402

slack = support.source("slack-messages")


def _norm(message, self_id=None):
    """The normalized spec of one message, read through the row."""
    snapshot = {"self_id": self_id} if self_id else {}
    return slack.message(message, snapshot_extra=snapshot)


def test_iso_of_timestamp_conversion():
    """A decimal-string ts converts to ISO-8601."""
    # "1234567890.123456" = 2009-02-13T23:31:30.123456 UTC
    iso = _norm({"ts": "1234567890.123456", "text": "x", "user": "U1"})["at"]
    assert iso is not None
    assert "2009-02-13" in iso
    assert "23:31:30" in iso
    assert "Z" in iso


def test_iso_of_malformed_timestamp():
    """Malformed timestamps give no time."""
    assert _norm({"ts": "not-a-number", "text": "x", "user": "U1"})["at"] is None
    assert _norm({"ts": "", "text": "x", "user": "U1"})["at"] is None
    assert _norm({"text": "x", "user": "U1"})["at"] is None


def test_speaker_me_by_self_id():
    """'me' is resolved by matching the user to the snapshot's own id."""
    msg = {"ts": "1", "user": "U123", "text": "hello"}
    assert _norm(msg, "U123")["speaker"] == "me"
    assert _norm(msg, "U456")["speaker"] != "me"


def test_speaker_bot_id():
    """bot_id speaker resolution."""
    msg = {"ts": "1", "bot_id": "B789", "text": "bot message"}
    assert _norm(msg, "B789")["speaker"] == "me"


def test_speaker_fallback_to_them():
    """Fallback to 'them' when there is no user and no bot_id."""
    assert _norm({"ts": "1", "text": "message"})["speaker"] == "them"


def test_speaker_names_the_person_not_the_profile_object():
    """A user_profile gives the person's real_name (the old code printed the
    whole profile object); a bot_profile gives the bot's name."""
    person = _norm({"ts": "1", "user": "U1", "text": "x",
                    "user_profile": {"real_name": "Sample Person", "id": "U1"}}, "U9")
    assert person["speaker"] == "Sample Person"
    bot = _norm({"ts": "1", "bot_id": "B1", "text": "x",
                 "bot_profile": {"name": "sample-bot", "id": "B1"}}, "U9")
    assert bot["speaker"] == "sample-bot"


def test_norm_message_text_preservation():
    """Message text is preserved."""
    norm = _norm({"ts": "1000", "text": "hello world", "user": "U123"}, "U456")
    assert norm["text"] == "hello world"
    assert norm["speaker"] != "me"


def test_norm_message_text_less():
    """Text-less messages have no text."""
    assert _norm({"ts": "1000", "user": "U123"}, "U456")["text"] is None
    assert _norm({"ts": "1001", "text": "", "user": "U123"}, "U456")["text"] is None


def test_norm_message_edited_ts_preferred():
    """edited.ts is preferred over ts."""
    norm = _norm({"ts": "1000", "text": "edited message", "user": "U123",
                  "edited": {"ts": "1500"}}, "U456")
    # 1500 seconds after the epoch is 00:25:00 (the plain ts would be 00:16:40)
    assert norm["at"] == "1970-01-01T00:25:00Z", norm["at"]


def test_norm_message_structure():
    """A normalized message has the required structure."""
    norm = _norm({"ts": "1000", "text": "hello", "user": "U123"}, "U456")
    for key in ("index", "speaker", "text", "at", "kind"):
        assert key in norm
    assert norm["kind"] == "utterance"


def test_thread_spec_with_messages():
    """Thread spec generation with messages."""
    specs, rejections = slack.thread_result({
        "self_id": "U123",
        "channels": [{
            "id": "C456",
            "name": "general",
            "messages": [
                {"ts": "1000", "text": "msg1", "user": "U123"},
                {"ts": "1001", "text": "msg2", "user": "U789"},
            ],
        }],
    })
    assert rejections == []
    assert specs[0]["session_id"] == "C456"
    assert specs[0]["title"] == "general"
    assert len(specs[0]["messages"]) == 2


def test_thread_spec_missing_id():
    """A channel without an id is rejected, never a crash."""
    specs, rejections = slack.thread_result({
        "self_id": "U123",
        "channels": [{"name": "no-id-channel", "messages": []}],
    })
    assert specs == []
    assert len(rejections) == 1
    assert "channel.id" in rejections[0]["violation_path"]


def test_source_row_is_valid_and_declared():
    """The row is the whole declaration of this source: it reads the generic
    `fields` format, names the channel list, and declares what a person may
    match a file by."""
    row = support.row("slack-messages")
    assert row["reader"] == "fields"
    assert row["shape"]["threads"]["list"] == {"path": ["channels"]}
    assert json.loads(json.dumps(row)) == row


def test_source_row_is_in_the_source_table():
    """The table the reader loads holds exactly one slack row."""
    table = json.loads((support.READ_DATA / "sources.json").read_text(encoding="utf-8"))["sources"]
    assert [r["id"] for r in table].count("slack-messages") == 1
    assert pathlib.Path(support.READ_DATA / "read_source.py").is_file()
