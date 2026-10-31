# tools/save-what-you-watch-and-read/test/python/test_source_pinterest_saved.py
#
# Fixture-based tests of the `pinterest-saved` source row, read through the one
# generic reader and the REAL mapper (the old tests stood a mock mapper in; the
# thread specs the reader hands the mapper are asserted through
# `support.source(...).thread_specs`, the atoms through `decode`).
import json
import pathlib
import tempfile

import support  # noqa: E402

pins = support.source("pinterest-saved")


def _write(snapshot_text):
    folder = pathlib.Path(tempfile.mkdtemp())
    path = folder / "snapshot.json"
    path.write_text(snapshot_text, encoding="utf-8")
    return str(path)


def _observation(path):
    return {"source_ref": "source:pinterest", "native_ref": path}


PINS_AND_BOARDS = {
    "account_id": "user123",
    "cursor": "2024-01-15T10:00:00Z",
    "categories": {
        "pins": {
            "items": [
                {
                    "id": "pin1",
                    "title": "Summer Vacation Ideas",
                    "description": "Beautiful beach destinations",
                    "created_at": "2024-01-10T08:00:00Z",
                    "image": {"original": {"url": "https://example.com/pin1.jpg", "width": 600, "height": 400}},
                    "board": {"id": "board1", "name": "Travel"},
                },
                {
                    "id": "pin2",
                    "title": "Healthy Recipes",
                    "description": "Quick weeknight dinners",
                    "created_at": "2024-01-12T09:30:00Z",
                    "image": {"original": {"url": "https://example.com/pin2.jpg", "width": 800, "height": 600}},
                    "board": {"id": "board2", "name": "Food"},
                },
            ]
        },
        "boards": {
            "items": [
                {"id": "board1", "name": "Travel", "description": "Travel inspiration",
                 "created_at": "2023-06-01T00:00:00Z"},
                {"id": "board2", "name": "Food", "description": "Recipes and cooking tips",
                 "created_at": "2023-07-15T00:00:00Z"},
            ]
        },
    },
}


def test_decode_fixture_pins_and_boards():
    """A snapshot holding both pins and boards: two threads, four atoms."""
    path = _write(json.dumps(PINS_AND_BOARDS))
    result = pins.decode(_observation(path), None)

    assert "atoms" in result
    assert "rejections" in result
    # Should have 4 atoms (2 pins + 2 boards)
    assert len(result["atoms"]) == 4
    assert len(result["rejections"]) == 0

    # The reader hands the mapper 2 specs (pins thread + boards thread)
    specs = pins.thread_specs(PINS_AND_BOARDS)
    assert len(specs) == 2
    assert specs[0]["session_id"] == "pins"
    assert specs[1]["session_id"] == "boards"
    assert len(specs[0]["messages"]) == 2  # 2 pins
    assert len(specs[1]["messages"]) == 2  # 2 boards
    assert specs[0]["messages"][0]["text"] == "Summer Vacation Ideas: Beautiful beach destinations"


def test_decode_fixture_malformed_snapshot():
    """Malformed JSON gives a structured rejection, not a crash."""
    path = _write("{ invalid json")
    result = pins.decode(_observation(path), None)

    assert "atoms" in result
    assert "rejections" in result
    assert len(result["atoms"]) == 0
    assert len(result["rejections"]) >= 1
    assert result["rejections"][0]["source_ref"] == "source:pinterest"


def test_decode_fixture_missing_file():
    """A missing snapshot file gives a structured rejection, not a crash."""
    result = pins.decode(_observation("/nonexistent/path/snapshot.json"), None)

    assert "atoms" in result
    assert "rejections" in result
    assert len(result["atoms"]) == 0
    assert len(result["rejections"]) >= 1


def test_decode_fixture_empty_snapshot():
    """An empty snapshot (no pins or boards) is processed, not rejected."""
    path = _write(json.dumps({
        "account_id": "user456",
        "categories": {"pins": {"items": []}, "boards": {"items": []}},
    }))
    result = pins.decode(_observation(path), None)

    assert len(result["atoms"]) == 0
    assert len(result["rejections"]) == 0


def test_decode_fixture_pin_without_title():
    """A pin without text is dropped by the mapper, not the reader (honest scope)."""
    snapshot = {
        "account_id": "user789",
        "categories": {
            "pins": {
                "items": [
                    {
                        "id": "pin_no_text",
                        # No title, no description
                        "created_at": "2024-01-15T00:00:00Z",
                        "image": {"original": {"url": "https://example.com/img.jpg"}},
                    }
                ]
            },
            "boards": {"items": []},
        },
    }
    # The mapper receives the pin but with no text (the mapper decides the drop)
    specs = pins.thread_specs(snapshot)
    pin_messages = specs[0]["messages"]
    assert len(pin_messages) == 1
    assert pin_messages[0]["text"] is None  # Dropped by mapper, not reader

    result = pins.decode(_observation(_write(json.dumps(snapshot))), None)
    assert result["atoms"] == []


def test_decode_window_pins():
    """decode_window pages the pins thread."""
    path = _write(json.dumps({
        "account_id": "user123",
        "categories": {
            "pins": {"items": [
                {"id": f"pin{i}", "title": f"Pin {i}", "created_at": "2024-01-15T00:00:00Z"}
                for i in range(10)
            ]},
            "boards": {"items": []},
        },
    }))
    result = pins.decode_window(_observation(path), None, before_cursor=10, limit=3, session_id="pins")

    assert len(result.get("atoms", [])) == 3
    assert [a["content"]["text"] for a in result["atoms"]] == ["Pin 7", "Pin 8", "Pin 9"]
    assert result["has_older"] is True
    assert result["older_cursor"] == 7
