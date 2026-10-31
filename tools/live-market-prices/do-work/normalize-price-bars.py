#!/usr/bin/env python3
# tools/live-market-prices/do-work/normalize-price-bars.py
#
# PURPOSE
#   Turn one market-data account's price-bars reply into price bars and each symbol's latest close. The reply is read
#   in the shape the other normalizers here read (status_code, body as an array of byte values), and every name in it
#   comes from the feed the person gives: where the bars are (bars_at) and what each field is called (fields).
#
#   build_result(reply, feed) -> { bars: [{ symbol, timestamp, open, high, low, close, volume }],
#                                  latest: { <symbol>: <close of its newest bar> },
#                                  status: { state, bar_count, http_status, fetched_at } }
#
# NON-NEGOTIABLE INVARIANTS
#   1. No venue's field names are written here: a bars node that is an object holds one list per symbol; a list holds
#      bars that each name their symbol in fields.symbol.
#   2. Never fabricate: a bar without a timestamp or a close is left out, a reply that is not 2xx JSON with the bars
#      node is an error with no bars, and a timestamp given as text is read as an ISO-8601 time.
#   3. Times are milliseconds since 1970 UTC; prices and volumes written as text are read as numbers.
import datetime
import json


def _number(value):
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _millis(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value:
        try:
            return int(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    return None


def _at(root, dotted):
    if not dotted:
        return root
    for part in str(dotted).split("."):
        if not isinstance(root, dict) or part not in root:
            return None
        root = root[part]
    return root


def _decode(reply):
    body = reply.get("body") if isinstance(reply, dict) else None
    if isinstance(body, list):
        try:
            body = bytes(body).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
    if isinstance(body, str):
        try:
            return json.loads(body)
        except ValueError:
            return None
    return body


def _bar(raw, symbol, fields):
    if not isinstance(raw, dict):
        return None
    timestamp = _millis(raw.get(fields["timestamp"]))
    close = _number(raw.get(fields["close"]))
    symbol = symbol if symbol is not None else raw.get(fields.get("symbol", ""))
    if timestamp is None or close is None or not isinstance(symbol, str) or not symbol:
        return None
    return {
        "symbol": symbol,
        "timestamp": timestamp,
        "open": _number(raw.get(fields.get("open", ""))),
        "high": _number(raw.get(fields.get("high", ""))),
        "low": _number(raw.get(fields.get("low", ""))),
        "close": close,
        "volume": _number(raw.get(fields.get("volume", ""))),
    }


def build_result(reply, feed):
    fields = feed["fields"]
    status_code = reply.get("status_code") if isinstance(reply, dict) else None
    data = _decode(reply) if isinstance(status_code, int) and 200 <= status_code < 300 else None
    node = _at(data, feed.get("bars_at")) if data is not None else None
    bars = []
    if isinstance(node, dict):
        for symbol, items in node.items():
            bars.extend(bar for bar in (_bar(item, symbol, fields) for item in (items if isinstance(items, list) else [])) if bar)
    elif isinstance(node, list):
        bars.extend(bar for bar in (_bar(item, None, fields) for item in node) if bar)
    bars.sort(key=lambda bar: (bar["symbol"], bar["timestamp"]))
    latest = {}
    for bar in bars:
        latest[bar["symbol"]] = bar["close"]
    return {
        "bars": bars,
        "latest": latest,
        "status": {
            "state": "live" if isinstance(node, (dict, list)) else "error",
            "bar_count": len(bars),
            "http_status": status_code,
            "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
    }
