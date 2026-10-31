#!/usr/bin/env python3
# package-set://bitfield-studio/packages/polymarket/do-work/normalize-order-book.test.py
#
# Tests for normalize-order-book.py — the CLOB /book normalizer. Run: python3 normalize-order-book.test.py
# Covers: byte-array decode, best bid/ask derivation (unsorted ladder), spread/midpoint math,
# string-number coercion, honest-empty on non-book bodies, malformed-level tolerance, token echo.

import json
import os
import sys

import importlib.util

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("nob", os.path.join(_HERE, "..", "do-work", "normalize-order-book.py"))
nob = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nob)


PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print("FAIL: %s" % name)


def as_byte_array(obj) -> list:
    """Encode a python obj as the int-array body that decode:bytes produces."""
    return list(json.dumps(obj).encode("utf-8"))


REAL_BOOK = {
    "market": "0xabc",
    "asset_id": "TOKEN_FROM_BODY",
    "timestamp": "1700000000000",
    "hash": "deadbeef",
    "bids": [
        {"price": "0.18", "size": "13411.49"},
        {"price": "0.2", "size": "3811.15"},   # highest bid
        {"price": "0.05", "size": "200"},
    ],
    "asks": [
        {"price": "0.99", "size": "310025.93"},
        {"price": "0.47", "size": "1478.63"},  # lowest ask
        {"price": "0.5", "size": "30"},
    ],
}


# 1. Happy path: byte-array body decodes, best bid/ask derived from UNSORTED ladder.
resp = {"status_code": 200, "body": as_byte_array(REAL_BOOK), "latency_ms": 12}
r = nob.build_result(resp, "TOKEN_REQ")
b = r["book"]
check("state live", r["status"]["state"] == "live")
check("http_status echoed", r["status"]["http_status"] == 200)
check("best_bid = max bid price", b["best_bid"] == 0.2)
check("best_ask = min ask price", b["best_ask"] == 0.47)
check("best_bid_size matches level", b["best_bid_size"] == 3811.15)
check("best_ask_size matches level", b["best_ask_size"] == 1478.63)
check("spread = ask-bid", abs(b["spread"] - (0.47 - 0.2)) < 1e-9)
check("midpoint = (ask+bid)/2", abs(b["midpoint"] - ((0.47 + 0.2) / 2.0)) < 1e-9)
check("levels counted", b["levels"] == 6)
check("bid_depth summed", abs(b["bid_depth"] - (13411.49 + 3811.15 + 200)) < 1e-6)
check("ask_depth summed", abs(b["ask_depth"] - (310025.93 + 1478.63 + 30)) < 1e-6)
check("prices coerced to float", all(isinstance(l["price"], float) for l in b["bids"]))
check("market passed through", b["market"] == "0xabc")
check("timestamp passed through", b["timestamp"] == "1700000000000")

# 2. token_id arg WINS over body asset_id (the requested token is authoritative).
check("token_id from arg", b["token_id"] == "TOKEN_REQ")
r2 = nob.build_result(resp, None)
check("token_id falls back to body asset_id", r2["book"]["token_id"] == "TOKEN_FROM_BODY")

# 3. Already-decoded body (string, not byte array) also works.
resp_str = {"status_code": 200, "body": json.dumps(REAL_BOOK)}
r3 = nob.build_result(resp_str, "T")
check("string body decodes", r3["status"]["state"] == "live")
check("string body best_ask", r3["book"]["best_ask"] == 0.47)

# 4. Honest empty: non-book body (e.g. an error object) -> state error, no fabrication.
resp_err = {"status_code": 404, "body": as_byte_array({"error": "not found"})}
r4 = nob.build_result(resp_err, "T")
check("non-book -> error", r4["status"]["state"] == "error")
check("non-book http_status", r4["status"]["http_status"] == 404)
check("non-book empty bids", r4["book"]["bids"] == [])
check("non-book best_bid None", r4["book"]["best_bid"] is None)
check("non-book spread None", r4["book"]["spread"] is None)
check("non-book note present", "note" in r4["status"])
check("non-book token echoed", r4["book"]["token_id"] == "T")

# 5. Bids only (one-sided book) — best_ask None, spread None, but state live.
resp_bids = {"status_code": 200, "body": as_byte_array({"bids": [{"price": "0.3", "size": "10"}], "asks": []})}
r5 = nob.build_result(resp_bids, "T")
check("one-sided still live", r5["status"]["state"] == "live")
check("one-sided best_bid set", r5["book"]["best_bid"] == 0.3)
check("one-sided best_ask None", r5["book"]["best_ask"] is None)
check("one-sided spread None", r5["book"]["spread"] is None)

# 6. Malformed levels are dropped, valid ones kept.
resp_mal = {"status_code": 200, "body": as_byte_array({
    "bids": [{"price": "0.3", "size": "10"}, {"price": "oops", "size": "5"}, {"size": "5"}, "notadict"],
    "asks": [{"price": "0.6", "size": "7"}],
})}
r6 = nob.build_result(resp_mal, "T")
check("malformed bids dropped", len(r6["book"]["bids"]) == 1)
check("malformed kept valid bid", r6["book"]["best_bid"] == 0.3)

# 7. Empty / garbage response -> honest empty error.
r7 = nob.build_result({}, "T")
check("empty resp -> error", r7["status"]["state"] == "error")
r8 = nob.build_result({"status_code": 200, "body": None}, "T")
check("null body -> error", r8["status"]["state"] == "error")

# 8. Empty book object (bids+asks both empty arrays) -> state error (no liquidity), but not a parse failure.
resp_empty_book = {"status_code": 200, "body": as_byte_array({"market": "0x1", "bids": [], "asks": []})}
r9 = nob.build_result(resp_empty_book, "T")
check("empty book -> error state", r9["status"]["state"] == "error")
check("empty book parsed market", r9["book"].get("token_id") == "T")

print("\n%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
