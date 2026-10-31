#!/usr/bin/env python3
# tools/save-what-you-watch-and-read/read-data/observe_activity.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# One thing the person watched, read, used or saved (a page they visited, words they selected, an app they spent a
# while in, an item in a feed) as ONE observation: what it was, where it came from, when it was seen, and an identity
# for what it held at that moment. The caller says what the thing was as an open object (`content`); this adds only
# what can be worked out from it and never what it means.
#
#   python3 observe_activity.py  < request
#
# The request is one JSON object on standard input:
#
#   source_ref    what this source is called (required): the name observations of this kind are kept under
#   content       what was seen (required, not empty): any object. Common fields: url, text, title, body, app, window,
#                 item_id, event, summary
#   native_ref    the item's own id; left out, its url, else the identity of its content
#   observed_at   when it was seen (ISO-8601 UTC); left out, now
#   metadata      anything the caller wants kept with the observation
#
# and the answer is its last line, `{"result": {"observation": {...}, "said": "..."}}` or `{"error": "..."}` with a
# non-zero status when the request cannot be answered. An observation is
# { id, source_ref, native_ref, observed_at, content_revision, payload }:
#   * `payload` is `content` with, for a url, its `host` (without a leading www.) and a `title` (the url itself) where
#     none was given, plus the source and the time; `metadata` goes in when given.
#   * `content_revision` is the BLAKE3 identity (`1f:`) of the payload without the time, so seeing the same page again
#     with the same words is the same revision and a changed page is a new one.
#   * `id` is the BLAKE3 identity of source_ref, native_ref and content_revision: one revision of one item from one
#     source has one id, however many times it is seen, which is what makes keeping it safe to repeat.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. NO NETWORK, NO FILES, NO TOKEN. It turns what it is given into an observation and reads nothing else.
# 2. It never branches on what kind of thing was seen. A page, an app window and a feed item are all an open `content`
#    object; a fifth kind of source needs no change here.
# 3. A request with nothing in `content` is refused; an empty observation is never invented.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
from __future__ import annotations

import datetime
import json
import pathlib
import sys
from urllib.parse import urlparse

HERE = pathlib.Path(__file__).resolve().parent
# The identity of bytes is the conversations folder's (one owner); a row of this tool packs that folder beside this one.
sys.path.insert(0, str(HERE.parents[1] / "conversations" / "read-data"))

from content_identity import content_hash  # noqa: E402


class Refusal(Exception):
    """The request cannot be answered; the message says what to do."""


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def host_of(url_text):
    """A readable label for where a url is from (`example.org`, no leading www.); empty when it has no host."""
    try:
        host = (urlparse(url_text).hostname or "").strip()
    except (ValueError, TypeError, AttributeError):
        host = ""
    return host[4:] if host.startswith("www.") else host


def _seen_at(value):
    if value is None:
        return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if not isinstance(value, str):
        raise Refusal("observed_at is an ISO-8601 time like 2026-01-02T08:00:00Z.")
    try:
        datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise Refusal("observed_at is an ISO-8601 time like 2026-01-02T08:00:00Z.") from error
    return value


def observe(request):
    """The observation for one request, or a Refusal."""
    if not isinstance(request, dict):
        raise Refusal("The request is one JSON object.")
    source_ref = request.get("source_ref")
    if not isinstance(source_ref, str) or not source_ref:
        raise Refusal("source_ref is required: what to call this source.")
    content = request.get("content")
    if not isinstance(content, dict) or not content:
        raise Refusal("content is required: an object saying what was seen (url, text, title, app, ...).")
    observed_at = _seen_at(request.get("observed_at"))

    payload = dict(content)
    url = payload.get("url")
    if isinstance(url, str) and url:
        payload.setdefault("host", host_of(url))
        payload.setdefault("title", url)
    payload.setdefault("source_ref", source_ref)
    if request.get("metadata") is not None:
        payload.setdefault("metadata", request["metadata"])

    revision = content_hash(_canonical(payload))
    native_ref = request.get("native_ref") or (url if isinstance(url, str) and url else None) or revision
    observation = {
        "id": content_hash(_canonical([source_ref, native_ref, revision])),
        "source_ref": source_ref,
        "native_ref": native_ref,
        "observed_at": observed_at,
        "content_revision": revision,
        "payload": {**payload, "observed_at": observed_at},
    }
    return {"observation": observation, "said": f"Observed {native_ref} from {source_ref} at {observed_at}."}


def main(argv):
    if len(argv) != 1:
        print(json.dumps({"error": "observe_activity.py takes its request on standard input and no arguments."}))
        return 2
    try:
        print(json.dumps({"result": observe(json.loads(sys.stdin.read() or "null"))},
                         ensure_ascii=False, separators=(",", ":")))
        return 0
    except Refusal as refusal:
        print(json.dumps({"error": str(refusal)}))
        return 2
    except ValueError as error:
        print(json.dumps({"error": f"The request is not JSON: {error}"}))
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
