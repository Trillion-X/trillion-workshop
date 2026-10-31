#!/usr/bin/env python3
# tools/live-market-prices/test/normalize-price-bars.test.py
#
# The price-bars normalizer with synthetic replies: bars by symbol or in one list, times as text or numbers, prices as
# text, bars without a time or a close left out, the newest close per symbol, and honest errors. No network.
import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bars", os.path.join(HERE, "..", "do-work", "normalize-price-bars.py"))
bars = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bars)

SHORT = {"timestamp": "t", "open": "o", "high": "h", "low": "l", "close": "c", "volume": "v"}
LONG = {"timestamp": "time", "close": "close", "symbol": "ticker"}


def reply(body, status=200):
    return {"status_code": status, "headers": {}, "body": list(json.dumps(body).encode("utf-8")), "latency_ms": 1}


class Bars(unittest.TestCase):
    def test_bars_by_symbol_are_read_sorted_with_the_newest_close_per_symbol(self):
        body = {"bars": {"BREAD": [{"t": "2026-01-02T15:05:00Z", "o": "10.5", "h": 12, "l": 10, "c": "11.75", "v": 120},
                                   {"t": "2026-01-02T15:00:00Z", "o": 10, "h": 11, "l": 9.5, "c": 10.5, "v": 300}]}}
        result = bars.build_result(reply(body), {"bars_at": "bars", "fields": SHORT})
        self.assertEqual([bar["timestamp"] for bar in result["bars"]], [1767366000000, 1767366300000])
        self.assertEqual(result["bars"][1], {"symbol": "BREAD", "timestamp": 1767366300000, "open": 10.5, "high": 12.0, "low": 10.0, "close": 11.75, "volume": 120.0})
        self.assertEqual(result["latest"], {"BREAD": 11.75})
        self.assertEqual(result["status"]["state"], "live")
        self.assertEqual(result["status"]["bar_count"], 2)
        self.assertEqual(result["status"]["http_status"], 200)

    def test_a_list_of_bars_names_each_symbol_and_numbers_are_times_already(self):
        body = {"data": {"rows": [{"time": 1767366000000, "close": 4, "ticker": "ROLL"}, {"time": 1767366000000, "close": 7, "ticker": "BREAD"}]}}
        result = bars.build_result(reply(body), {"bars_at": "data.rows", "fields": LONG})
        self.assertEqual(result["latest"], {"BREAD": 7.0, "ROLL": 4.0})
        self.assertIsNone(result["bars"][0]["open"])

    def test_the_whole_answer_is_the_bars_when_no_place_is_named(self):
        result = bars.build_result(reply([{"time": "2026-01-02T15:00:00+00:00", "close": "3", "ticker": "BREAD"}]), {"fields": LONG})
        self.assertEqual(result["latest"], {"BREAD": 3.0})

    def test_a_bar_without_a_time_a_close_or_a_symbol_is_left_out(self):
        body = [{"time": "not a time", "close": 1, "ticker": "A"}, {"time": 5, "ticker": "B"}, {"time": 5, "close": 1}, {"time": 5, "close": "x", "ticker": "C"}, "junk"]
        result = bars.build_result(reply(body), {"fields": LONG})
        self.assertEqual(result["bars"], [])
        self.assertEqual(result["status"]["state"], "live")

    def test_an_error_status_a_body_that_is_not_json_or_no_bars_node_is_an_error_with_no_bars(self):
        for given in (reply({"bars": {}}, 403), {"status_code": 200, "body": list(b"not json")}, reply({"other": 1}), {}):
            result = bars.build_result(given, {"bars_at": "bars", "fields": SHORT})
            self.assertEqual((result["status"]["state"], result["bars"], result["latest"]), ("error", [], {}), given)


if __name__ == "__main__":
    unittest.main()
