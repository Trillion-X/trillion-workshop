#!/usr/bin/env python3
# package-set://bitfield-studio/packages/polymarket/do-work/normalize-order-book.py
#
# Purpose:
#   Normalize the Polymarket CLOB /book response into a clean, self-describing order-book
#   snapshot the AI + UI consume. Pure transform over the HTTP response. PUBLIC read — no auth.
#
# Why python (the byte-array trap fix):
#   slot::http-client returns the response with `decode:"bytes"` — `body` is an INT ARRAY
#   (Vec<u8>), NOT a string. The engine cannot json-decode it for us. So this step:
#     1. reads the mounted http-response.json (the http_fetch step's bytes, via step_bytes)
#     2. body (int array) -> bytes -> utf-8 -> json.loads  (the canonical trap fix)
#     3. derives best bid/ask, spread, midpoint from the ladder
#     4. emits {book, status} so the workflow writes a book snapshot + a status record.
#
# Contract:
#   inputs (mounted): http-response.json = the http_fetch reply {status_code, headers, body, latency_ms}
#   argv[1] = output mount path (default order-book-normalized.json)
#   argv[2] = the token_id this book was requested for (echoed into the snapshot; CLOB calls it asset_id)
#   outputs: order-book-normalized.json + stdout JSON = {book:{...}, status:{...}}
#   stdout book (self-describing — every field a book consumer needs; the AI/UI read by field name):
#     { token_id, market, timestamp, hash,
#       bids:[{price,size}...], asks:[{price,size}...],   # full ladder, prices+sizes as floats
#       best_bid, best_ask, best_bid_size, best_ask_size, spread, midpoint,
#       bid_depth, ask_depth, levels }
#   status: { state:"live"|"error", token_id, http_status, fetched_at, note? }
#
# Non-Negotiable Invariants:
#   1. NEVER fabricate a book. If the response is not a CLOB book object (no bids/asks), emit
#      an empty book with status.state="error" and the http_status — an honest empty, never fake.
#   2. No hardcoded market / outcome. The book is for whatever token_id was requested; bids/asks
#      ride as DATA from the response. A book for any market normalizes the same way.
#   3. Tolerate CLOB's string-encoded numbers: price/size arrive as JSON STRINGS
#      (e.g. "0.51") — coerce to float. Best bid = max bid price; best ask = min ask price
#      (the ladder is not guaranteed sorted), so derive, never assume order.

import datetime
import json
import sys


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _num(value):
    """CLOB sends price/size as strings. Coerce to float; None if not numeric."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except (ValueError, TypeError):
            return None
    return None


def _levels(raw):
    """Normalize a bids/asks list into [{price,size}] with float price+size. Drop malformed."""
    out = []
    if not isinstance(raw, list):
        return out
    for lvl in raw:
        if not isinstance(lvl, dict):
            continue
        price = _num(lvl.get("price"))
        size = _num(lvl.get("size"))
        if price is None or size is None:
            continue
        out.append({"price": price, "size": size})
    return out


def _decode_body(resp):
    """Return (parsed_body_or_None, http_status). decode:bytes => body is an int array."""
    http_status = None
    body = None
    if isinstance(resp, dict):
        http_status = resp.get("status_code")
        body = resp.get("body")
    if isinstance(body, list):
        try:
            body = bytes(bytearray(body)).decode("utf-8")
        except (ValueError, TypeError):
            body = None
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except (ValueError, TypeError):
            body = None
    if body is None and isinstance(resp, dict) and "body" not in resp:
        body = resp
    return body, http_status


def build_result(resp, token_id=None) -> dict:
    body, http_status = _decode_body(resp)
    # A valid CLOB book is an object carrying bids/asks.
    if not isinstance(body, dict) or ("bids" not in body and "asks" not in body):
        return {
            "book": {
                "token_id": token_id,
                "bids": [],
                "asks": [],
                "best_bid": None,
                "best_ask": None,
                "spread": None,
                "midpoint": None,
                "levels": 0,
            },
            "status": {
                "state": "error",
                "token_id": token_id,
                "http_status": http_status,
                "fetched_at": _utc_now_iso(),
                "note": "response body was not a CLOB book object (HTTP %s)" % http_status,
            },
        }

    bids = _levels(body.get("bids"))
    asks = _levels(body.get("asks"))
    # Best bid = highest price someone will BUY at; best ask = lowest price someone will SELL at.
    best_bid_lvl = max(bids, key=lambda x: x["price"]) if bids else None
    best_ask_lvl = min(asks, key=lambda x: x["price"]) if asks else None
    best_bid = best_bid_lvl["price"] if best_bid_lvl else None
    best_ask = best_ask_lvl["price"] if best_ask_lvl else None
    spread = (best_ask - best_bid) if (best_bid is not None and best_ask is not None) else None
    midpoint = ((best_ask + best_bid) / 2.0) if (best_bid is not None and best_ask is not None) else None

    book = {
        "token_id": token_id or body.get("asset_id"),
        "market": body.get("market"),
        "timestamp": body.get("timestamp"),
        "hash": body.get("hash"),
        "bids": bids,
        "asks": asks,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "best_bid_size": best_bid_lvl["size"] if best_bid_lvl else None,
        "best_ask_size": best_ask_lvl["size"] if best_ask_lvl else None,
        "spread": spread,
        "midpoint": midpoint,
        "bid_depth": sum(l["size"] for l in bids),
        "ask_depth": sum(l["size"] for l in asks),
        "levels": len(bids) + len(asks),
    }
    return {
        "book": book,
        "status": {
            "state": "live" if (bids or asks) else "error",
            "token_id": book["token_id"],
            "http_status": http_status,
            "fetched_at": _utc_now_iso(),
        },
    }


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "order-book-normalized.json"
    token_id = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    try:
        with open("http-response.json") as f:
            resp = json.loads(f.read())
    except (OSError, ValueError):
        resp = {}
    result = build_result(resp, token_id)
    with open(out_path, "w") as f:
        json.dump(result, f)
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
