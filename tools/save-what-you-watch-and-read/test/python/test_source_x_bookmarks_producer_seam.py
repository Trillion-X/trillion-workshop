# tools/save-what-you-watch-and-read/test/python/test_source_x_bookmarks_producer_seam.py
#
# SEAM PROOF, reader half: the connector that pulls saved posts writes a snapshot
# file; the `x-bookmarks` source row reads it. This test feeds the reader a
# snapshot in exactly the shape the connector's store writes (the authenticated
# user's id, the account, the pagination token, the raw post objects as the API
# returns them, the set of folded ids) and asserts canonical output comes out.
# The connector's own half (running the bounded pull with an injected transport
# and checking the file it wrote) belongs to the connector's test, not here.
#
# No network, no vault. Run: python3 run_tests.py test_source_x_bookmarks_producer_seam.py
import json
import pathlib
import tempfile
import unittest

import support  # noqa: E402

xb = support.source("x-bookmarks")

# Realistic API v2 shapes: the stored posts carry the exact fields the connector
# requests (created_at, author_id, text), under the identity the pull resolved.
PRODUCED = {
    "user_id": "77",
    "account_ref": "sample",
    "pagination_token": "PAGE2",
    "bookmarks": [
        {"id": "t1", "text": "first bookmarked tweet", "author_id": "900", "created_at": "2026-07-01T10:00:00.000Z"},
        {"id": "t2", "text": "second bookmarked tweet", "author_id": "901", "created_at": "2026-07-02T11:00:00.000Z"},
    ],
    "deduped_tweet_ids": {"t1": True, "t2": True},
}

PRODUCED_EMPTY = {
    "user_id": "77",
    "account_ref": "empty",
    "pagination_token": None,
    "bookmarks": [],
    "deduped_tweet_ids": {},
}


class SeamTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _snapshot_file(self, name, snapshot):
        path = pathlib.Path(self.tmp.name) / name
        path.write_text(json.dumps(snapshot), encoding="utf-8")
        return path

    def test_producer_snapshot_decodes_end_to_end(self):
        # The snapshot file the connector wrote is read VERBATIM by the reader.
        path = self._snapshot_file("sample.json", PRODUCED)
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        thread_specs = xb.thread_specs(snapshot)

        # The reader actually read the producer's shape -> both tweets survive.
        self.assertEqual(len(thread_specs), 2, 'reader must decode both bookmarked tweets from the producer snapshot')
        session_ids = {s['session_id'] for s in thread_specs}
        self.assertEqual(session_ids, {'t1', 't2'})
        # the tweet text (producer stored the raw tweet dict; the reader must find .text) survives the seam
        texts = {s['messages'][0]['text'] for s in thread_specs}
        self.assertIn('first bookmarked tweet', texts)
        self.assertIn('second bookmarked tweet', texts)

        # And the same file decodes through the uniform contract to canonical atoms.
        result = xb.decode({"source_ref": "source:x", "native_ref": str(path)}, {"display_mark_ref": "mark:x"})
        self.assertEqual(result["rejections"], [])
        self.assertEqual(len(result["atoms"]), 2)

    def test_empty_bookmarks_seam_is_clean(self):
        # The producer writes a valid empty snapshot; the reader yields zero specs, no crash.
        path = self._snapshot_file("empty.json", PRODUCED_EMPTY)
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(xb.thread_specs(snapshot), [])
