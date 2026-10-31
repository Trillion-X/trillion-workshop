#!/usr/bin/env python3
# package-set://bitfield-studio/packages/polymarket/do-work/normalize-gamma-markets.py
#
# Purpose:
#   Normalize the Polymarket Gamma API /markets response into a clean, self-describing
#   list of prediction markets the AI + UI consume. Pure transform over the HTTP response.
#
# Why python (the byte-array trap fix):
#   slot::http-client returns the response with `decode:"bytes"` — `body` is an INT ARRAY
#   (Vec<u8>), NOT a string. The engine cannot json-decode it for us. So this step:
#     1. reads the mounted http-response.json (the http_fetch step's bytes, via step_bytes)
#     2. body (int array) -> bytes -> utf-8 -> json.loads  (the canonical trap fix)
#     3. extracts each market's fields into a stable shape
#     4. emits {markets, status} so the workflow writes markets + a status record.
#
# Contract:
#   inputs (mounted): http-response.json = the http_fetch reply {status_code, headers, body, latency_ms}
#   outputs: markets-normalized.json + stdout JSON = {markets:[...], status:{...}}
#   stdout markets[] element (self-describing — every field Gamma exposes that a market
#   consumer needs; the AI/UI read by field name, no hardcoded enum of which markets exist):
#     { id, question, slug, condition_id, outcomes:[...], outcome_prices:[...],
#       token_ids:[...], volume, liquidity, active, closed, accepting_orders,
#       end_date, start_date, min_tick_size, min_order_size, image }
#   status: { state:"live"|"error", market_count, http_status, fetched_at, note? }
#
# Non-Negotiable Invariants:
#   1. NEVER fabricate a market. If the response is not a JSON array of markets, emit
#      markets:[] with status.state="error" and the http_status — an honest empty, never fake.
#   2. No hardcoded market list / outcome enum. Outcomes ("Yes"/"No" today, anything
#      tomorrow) and token ids ride as DATA from the response. A market with 3 outcomes
#      or a non-binary market normalizes the same way — zero code change.
#   3. Tolerate Gamma's string-encoded JSON fields: `outcomes`, `outcomePrices`,
#      `clobTokenIds` arrive as JSON STRINGS (e.g. "[\"Yes\", \"No\"]") — parse them.

import datetime
import json
import sys


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _maybe_json_list(value):
    """Gamma encodes outcomes/outcomePrices/clobTokenIds as JSON strings. Parse to list."""
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except (ValueError, TypeError):
            return []
    return []


def _num(value):
    """Gamma sends numbers as strings (volume, liquidity) and as numbers (volumeNum). Coerce."""
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


def normalize_market(m: dict) -> dict:
    if not isinstance(m, dict):
        return {}
    return {
        "id": m.get("id"),
        "question": m.get("question"),
        "slug": m.get("slug"),
        "condition_id": m.get("conditionId"),
        "outcomes": _maybe_json_list(m.get("outcomes")),
        "outcome_prices": _maybe_json_list(m.get("outcomePrices")),
        "token_ids": _maybe_json_list(m.get("clobTokenIds")),
        "volume": _num(m.get("volumeNum")) if m.get("volumeNum") is not None else _num(m.get("volume")),
        "liquidity": _num(m.get("liquidityNum")) if m.get("liquidityNum") is not None else _num(m.get("liquidity")),
        "active": m.get("active"),
        "closed": m.get("closed"),
        "accepting_orders": m.get("acceptingOrders") if "acceptingOrders" in m else m.get("enableOrderBook"),
        "end_date": m.get("endDate"),
        "start_date": m.get("startDate"),
        "min_tick_size": m.get("orderPriceMinTickSize"),
        "min_order_size": m.get("orderMinSize"),
        "image": m.get("image"),
    }


def extract_markets(resp):
    """Return (markets_list_or_None, http_status). markets is None when the body isn't a market array."""
    http_status = None
    body = None
    if isinstance(resp, dict):
        http_status = resp.get("status_code")
        body = resp.get("body")
    # decode:"bytes" => body is an int array (Vec<u8>). Decode -> str -> json.
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
    data = body if body is not None else (resp if not isinstance(resp, dict) or "body" not in resp else None)
    # Gamma /markets returns a top-level JSON array. Some endpoints wrap in {"data":[...]}.
    if isinstance(data, list):
        return data, http_status
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        return data["data"], http_status
    return None, http_status


def build_result(resp) -> dict:
    raw_markets, http_status = extract_markets(resp)
    if raw_markets is None:
        return {
            "markets": [],
            "status": {
                "state": "error",
                "market_count": 0,
                "http_status": http_status,
                "fetched_at": _utc_now_iso(),
                "note": "response body was not a Gamma market array (HTTP %s)" % http_status,
            },
        }
    markets = [normalize_market(m) for m in raw_markets if isinstance(m, dict)]
    return {
        "markets": markets,
        "status": {
            "state": "live" if markets else "error",
            "market_count": len(markets),
            "http_status": http_status,
            "fetched_at": _utc_now_iso(),
        },
    }


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "markets-normalized.json"
    try:
        with open("http-response.json") as f:
            resp = json.loads(f.read())
    except (OSError, ValueError):
        resp = {}
    result = build_result(resp)
    with open(out_path, "w") as f:
        json.dump(result, f)
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
