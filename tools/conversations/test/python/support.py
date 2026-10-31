"""What the Python tests share: read-data on the import path, the source rows, and
a source under test (one row of read-data/sources.json bound to its reader), so a
test written for one source's decoder calls `decode`, `decode_window` and
`decode_summary_page` the way it always did."""
import json
import pathlib
import sys
import tempfile

READ_DATA = pathlib.Path(__file__).resolve().parents[2] / "read-data"
if str(READ_DATA) not in sys.path:
    sys.path.insert(0, str(READ_DATA))

import read_source  # noqa: E402
import transcript_mapper  # noqa: E402

SOURCES = json.loads((READ_DATA / "sources.json").read_text(encoding="utf-8"))["sources"]


def row(source_id):
    """The source row with this id."""
    return next(item for item in SOURCES if item["id"] == source_id)


class SourceUnderTest:
    """One source row with the decoder contract its old decoder had."""

    def __init__(self, source_id, source_row=None):
        """`source_row` stands in for the table's row (a test of what a changed row does)."""
        self.row = source_row or row(source_id)
        self.tm = transcript_mapper

    def decode_summary(self, observation, descriptor=None, tail=6):
        """The bounded list projection of a database source."""
        return read_source.decode_sqlite_summary(observation, self.row, descriptor, tail)

    def record_message(self, record, index=0):
        """The normalized spec of ONE database message record (no database needed)."""
        return read_source.sqlite_message(self.row, record, index)

    def reaction(self, record):
        """The normalized spec of ONE database reaction record (no database needed)."""
        return read_source.sqlite_reaction(self.row, record)

    def decode(self, observation, descriptor=None):
        return read_source.decode(observation, self.row, descriptor)

    def decode_window(self, observation, descriptor=None, before_cursor=None, limit=256, session_id=None):
        return read_source.decode_window(observation, self.row, descriptor, before_cursor, limit, session_id)

    def decode_summary_page(self, observation, descriptor=None, cursor=None, limit=8):
        return read_source.decode_summary_page(observation, self.row, descriptor, cursor, limit)

    def decode_batch(self, request):
        return read_source.decode_batch(request, self.row)

    def thread_result(self, snapshot):
        """(thread specs, rejections) one snapshot (a Python value) gives, written to a file first."""
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "snapshot.json"
            path.write_text(json.dumps(snapshot), encoding="utf-8")
            specs, rejections, _ = read_source.thread_specs(self.row, str(path))
        return (specs if specs is not None else []), rejections

    def thread_specs(self, snapshot):
        """The thread specs one snapshot (a Python value) gives."""
        return self.thread_result(snapshot)[0]

    def message(self, message, snapshot_extra=None, thread_extra=None):
        """The normalized spec of ONE message, read inside a one-thread snapshot
        built from the row's own thread and message lists."""
        snapshot = dict(snapshot_extra or {})
        thread = {"id": "thread-under-test", **(thread_extra or {}), "messages": [message]}
        key = self.row["shape"].get("root_list_key", "threads")
        snapshot.setdefault(key, [thread])
        specs = self.thread_specs(snapshot)
        return specs[0]["messages"][0] if specs and specs[0]["messages"] else None


def source(source_id, source_row=None):
    return SourceUnderTest(source_id, source_row)


def write_json(folder, name, value):
    path = pathlib.Path(folder) / name
    path.write_text(json.dumps(value), encoding="utf-8")
    return str(path)
