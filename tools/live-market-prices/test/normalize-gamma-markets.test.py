#!/usr/bin/env python3
# package-set://bitfield-studio/packages/polymarket/do-work/normalize-gamma-markets.test.py
#
# Tests for the Gamma market normalizer. Uses the REAL response shape captured live from
# slot::http-client (decode:bytes -> body is an int array; Gamma string-encodes outcomes).
# Run: python3 normalize-gamma-markets.test.py

import importlib.util
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("norm", os.path.join(_HERE, "..", "do-work", "normalize-gamma-markets.py"))
norm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(norm)

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}")


# A real Gamma market (trimmed) as it actually arrives.
REAL_MARKET = {
    "id": "9001",
    "question": "Will the sample team win the sample cup?",
    "slug": "will-the-sample-team-win-the-sample-cup",
    "conditionId": "0x1abc00000000000000000000000000000000000000000000000000000000beef",
    "outcomes": "[\"Yes\", \"No\"]",
    "outcomePrices": "[\"0.51\", \"0.49\"]",
    "clobTokenIds": "[\"111\", \"222\"]",
    "volume": "1234.5",
    "volumeNum": 1234.5,
    "liquidity": "99.5",
    "liquidityNum": 99.5,
    "active": True,
    "closed": False,
    "enableOrderBook": True,
    "endDate": "2030-01-01T12:00:00Z",
    "startDate": "2029-01-01T00:00:00.000Z",
    "orderPriceMinTickSize": 0.01,
    "orderMinSize": 5,
    "image": "https://example.invalid/img.jpg",
}


def http_reply(markets_json_str, status_code=200):
    """Mimic slot::http-client decode:bytes — body is an int array of the utf-8 JSON."""
    body_bytes = list(markets_json_str.encode("utf-8"))
    return {"status_code": status_code, "headers": {}, "body": body_bytes, "latency_ms": 12}


# 1. Real market normalizes with parsed outcomes/prices/tokens.
nm = norm.normalize_market(REAL_MARKET)
check("id extracted", nm["id"] == "9001")
check("question extracted", nm["question"] == "Will the sample team win the sample cup?")
check("condition_id extracted", nm["condition_id"].startswith("0x1abc00"))
check("outcomes parsed from JSON string", nm["outcomes"] == ["Yes", "No"])
check("outcome_prices parsed from JSON string", nm["outcome_prices"] == ["0.51", "0.49"])
check("token_ids parsed from clobTokenIds string", nm["token_ids"] == ["111", "222"])
check("volume prefers volumeNum (number)", nm["volume"] == 1234.5)
check("liquidity prefers liquidityNum", nm["liquidity"] == 99.5)
check("active bool", nm["active"] is True)
check("closed bool", nm["closed"] is False)
check("accepting_orders from enableOrderBook", nm["accepting_orders"] is True)
check("min_tick_size", nm["min_tick_size"] == 0.01)
check("min_order_size", nm["min_order_size"] == 5)

# 2. Full pipeline over a decode:bytes reply (the real http-client shape).
reply = http_reply(json.dumps([REAL_MARKET, REAL_MARKET]))
res = norm.build_result(reply)
check("pipeline market_count=2", res["status"]["market_count"] == 2)
check("pipeline state live", res["status"]["state"] == "live")
check("pipeline http_status 200", res["status"]["http_status"] == 200)
check("pipeline markets are normalized", res["markets"][0]["outcomes"] == ["Yes", "No"])

# 3. body as a plain STRING (some clients) still works.
res2 = norm.build_result({"status_code": 200, "body": json.dumps([REAL_MARKET])})
check("string body path works", res2["status"]["market_count"] == 1)

# 4. {"data":[...]} wrapper supported.
res3 = norm.build_result(http_reply(json.dumps({"data": [REAL_MARKET]})))
check("data-wrapper supported", res3["status"]["market_count"] == 1)

# 5. HONEST ERROR: a Cloudflare 403 body (object, not array) -> markets:[], error, status echoed.
cf403 = http_reply(json.dumps({"title": "Error 1010: Access denied", "status": 403}), status_code=403)
res4 = norm.build_result(cf403)
check("403 -> markets empty", res4["markets"] == [])
check("403 -> state error", res4["status"]["state"] == "error")
check("403 -> http_status echoed", res4["status"]["http_status"] == 403)
check("403 -> note present (no fake markets)", "note" in res4["status"])

# 6. Empty array -> error state (nothing fabricated), count 0.
res5 = norm.build_result(http_reply("[]"))
check("empty array -> count 0", res5["status"]["market_count"] == 0)
check("empty array -> state error", res5["status"]["state"] == "error")

# 7. Garbage body -> honest empty.
res6 = norm.build_result(http_reply("not json at all"))
check("garbage -> markets empty", res6["markets"] == [])
check("garbage -> state error", res6["status"]["state"] == "error")

# 8. Non-binary market (3 outcomes) normalizes the same — no hardcoded enum.
tri = dict(REAL_MARKET, outcomes="[\"A\", \"B\", \"C\"]", outcomePrices="[\"0.3\", \"0.3\", \"0.4\"]")
check("3-outcome market generic", norm.normalize_market(tri)["outcomes"] == ["A", "B", "C"])

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(0 if FAIL == 0 else 1)
