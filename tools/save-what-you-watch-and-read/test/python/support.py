"""What the Python tests share: this folder's read-data and the conversations folder's read-data (the reader of saved
items) on the import path, this folder's source rows, and a source under test (one row of read-data/sources.json bound
to the conversations reader), so a test for one kind of saved-items export calls `decode`, `decode_window` and
`decode_summary_page` the way the reader's own tests do."""
import importlib.util
import json
import pathlib
import sys

FOLDER = pathlib.Path(__file__).resolve().parents[2]
READ_DATA = FOLDER / "read-data"
CONVERSATIONS = FOLDER.parent / "conversations" / "test" / "python" / "support.py"

SOURCES = json.loads((READ_DATA / "sources.json").read_text(encoding="utf-8"))["sources"]

# The conversations folder's support puts its read-data on the import path and owns the source-under-test class.
_spec = importlib.util.spec_from_file_location("conversations_support", CONVERSATIONS)
conversations_support = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(conversations_support)
for _path in (str(READ_DATA),):
    if _path not in sys.path:
        sys.path.insert(0, _path)


def row(source_id):
    """The source row with this id."""
    return next(item for item in SOURCES if item["id"] == source_id)


def source(source_id, source_row=None):
    """One of this folder's rows bound to the conversations reader."""
    return conversations_support.SourceUnderTest(source_id, source_row or row(source_id))


def write_json(folder, name, value):
    return conversations_support.write_json(folder, name, value)
