#!/usr/bin/env python3
# tools/live-market-prices/do-work/read-market-prices.py
#
# PURPOSE
#   The command the container rows of this folder run. It does the one GET a row names (the public market list, one
#   outcome's public order book, or price bars from the person's own market-data account), hands the reply to the
#   carried normalizer exactly as the old engine's http client did (status_code, headers, body as an array of byte
#   values, latency_ms), and prints the normalizer's answer as the last line of standard output.
#
#     python3 read-market-prices.py markets   < {"limit"?: 1..most_limit}
#     python3 read-market-prices.py book      < {"token_id": "<outcome token>"}
#     python3 read-market-prices.py bars      < {"feed": {...}, "query"?: {...}}   held credentials on descriptor 3
#
# NON-NEGOTIABLE INVARIANTS
#   1. The public addresses, paths, query names, headers, User-Agent and default limit are DATA
#      (sources/public-markets-api.json); a market-data account's address, query, credential places and field names are
#      the person's feed, given with the request. Nothing here names a venue.
#   2. Never fabricate: a reply that is not a market list, a book or price bars comes back as the normalizer's honest
#      empty with the HTTP status; a request that never got a reply says so in status.note.
#   3. GET only, no cookie. The public reads take no credential. The bars read takes the held market-data-credentials
#      (a JSON object of named fields) from descriptor 3 and puts each field only where the feed says; no answer, note
#      or error carries one.
import importlib.util
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
SOURCE_FILE = HERE.parent / "sources" / "public-markets-api.json"


def load_source():
    return json.loads(SOURCE_FILE.read_text(encoding="utf-8"))


def load_normalizer(file_name):
    spec = importlib.util.spec_from_file_location(file_name.replace("-", "_").removesuffix(".py"), HERE / file_name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def urllib_http(url, headers, timeout):
    """One GET. Returns (status_code, body_bytes). An HTTP error status is a reply; a transport failure raises."""
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def reply_of(http, url, headers, timeout):
    """The reply shape the carried normalizers read: {status_code, headers, body: [byte values], latency_ms}."""
    started = time.monotonic()
    status, body = http(url, headers, timeout)
    return {"status_code": status, "headers": {}, "body": list(body), "latency_ms": int((time.monotonic() - started) * 1000)}


def request_headers(source, part):
    return {**part.get("headers", {}), "User-Agent": source["user_agent"]}


def read_markets(request, http=urllib_http, source=None):
    source = source or load_source()
    part = source["markets"]
    limit = request.get("limit", part["default_limit"])
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= part["most_limit"]:
        raise ValueError("limit must be a whole number from 1 to %d" % part["most_limit"])
    query = {**part["query"], part["limit_param"]: limit}
    url = part["base_url"] + part["path"] + "?" + urllib.parse.urlencode(query)
    normalizer = load_normalizer(part["normalizer"])
    try:
        reply = reply_of(http, url, request_headers(source, part), part["timeout_seconds"])
    except (OSError, ValueError) as error:
        result = normalizer.build_result({})
        result["status"]["note"] = "could not reach the market list: %s" % error
        return result
    return normalizer.build_result(reply)


def read_order_book(request, http=urllib_http, source=None):
    source = source or load_source()
    part = source["order_book"]
    token_id = request.get("token_id")
    if not isinstance(token_id, str) or not token_id.strip():
        raise ValueError("token_id is required: the outcome token of a market, from the market list's token_ids")
    token_id = token_id.strip()
    url = part["base_url"] + part["path"] + "?" + urllib.parse.urlencode({part["token_param"]: token_id})
    normalizer = load_normalizer(part["normalizer"])
    try:
        reply = reply_of(http, url, request_headers(source, part), part["timeout_seconds"])
    except (OSError, ValueError) as error:
        result = normalizer.build_result({}, token_id)
        result["status"]["note"] = "could not reach the order book: %s" % error
        return result
    return normalizer.build_result(reply, token_id)


CREDENTIAL_DESCRIPTOR = 3
FEED_SHAPE = ('feed: { url, query?, query_names?, headers?, credential_injections: [{ field, placement: { kind: "header" | "query", '
              'name, prefix? } }], bars_at?, fields: { timestamp, close, open?, high?, low?, volume?, symbol? }, timeout_seconds? }')


def read_held():
    """The held market-data-credentials: a JSON object of named text fields, on its descriptor."""
    try:
        with os.fdopen(CREDENTIAL_DESCRIPTOR, encoding="utf-8") as pipe:
            held = json.loads(pipe.read())
    except (OSError, ValueError):
        held = None
    if not isinstance(held, dict):
        raise ValueError('the held value market-data-credentials must be a JSON object of named fields, such as { "key_id": "...", "secret": "..." }')
    return held


def read_price_bars(request, http=urllib_http, held=None):
    feed = request.get("feed")
    fields = feed.get("fields") if isinstance(feed, dict) else None
    if not isinstance(feed, dict) or not isinstance(feed.get("url"), str) or not isinstance(fields, dict) \
            or not all(isinstance(fields.get(name), str) and fields[name] for name in ("timestamp", "close")):
        raise ValueError("no market-data feed was given, so nothing was read. Give " + FEED_SHAPE)
    query = request.get("query") or {}
    allowed = feed.get("query_names")
    if not isinstance(query, dict) or (isinstance(allowed, list) and any(name not in allowed for name in query)):
        raise ValueError("query must be an object of the names the feed allows: %s" % ", ".join(allowed or []))
    held = read_held() if held is None else held
    parts = urllib.parse.urlsplit(feed["url"])
    pairs = urllib.parse.parse_qsl(parts.query) + [(name, str(value)) for name, value in {**(feed.get("query") or {}), **query}.items() if value not in (None, "")]
    headers = {**feed.get("headers", {"accept": "application/json"}), "User-Agent": load_source()["user_agent"]}
    for injection in feed.get("credential_injections") or []:
        field, placement = injection.get("field"), injection.get("placement") or {}
        value = held.get(field)
        if not isinstance(value, str) or not value:
            raise ValueError('the feed needs the field "%s" of the held value market-data-credentials, and it has no such field' % field)
        value = placement.get("prefix", "") + value
        if placement.get("kind") == "header" and placement.get("name"):
            headers[placement["name"]] = value
        elif placement.get("kind") == "query" and placement.get("name"):
            pairs.append((placement["name"], value))
        else:
            raise ValueError('credential placement for field "%s" must be { kind: "header" | "query", name }' % field)
    url = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(pairs), ""))
    normalizer = load_normalizer("normalize-price-bars.py")
    try:
        reply = reply_of(http, url, headers, feed.get("timeout_seconds", 30))
    except (OSError, ValueError):
        result = normalizer.build_result({}, feed)
        result["status"]["note"] = "could not reach the market-data account"
        return result
    return normalizer.build_result(reply, feed)


COMMANDS = {"markets": read_markets, "book": read_order_book, "bars": read_price_bars}


def main(argv, stdin=None, http=urllib_http):
    if len(argv) != 2 or argv[1] not in COMMANDS:
        sys.stderr.write("usage: read-market-prices.py markets|book|bars < request.json\n")
        return 2
    try:
        text = (stdin or sys.stdin).read()
        request = json.loads(text) if text.strip() else {}
        if not isinstance(request, dict):
            raise ValueError("the request must be a JSON object")
        print(json.dumps(COMMANDS[argv[1]](request, http=http)))
        return 0
    except ValueError as error:
        sys.stderr.write("%s\n" % error)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
