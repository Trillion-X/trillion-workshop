#!/usr/bin/env python3
# tools/live-market-prices/test/read-market-prices.seam.py
#
# The seam of this folder with a fake HTTP in place of the network: the wrapper builds the request from the DATA row,
# sends the User-Agent, hands the reply to the carried normalizer and answers its result. Every body is synthetic.
# Run by live-market-prices.test.mjs. No network.
import importlib.util
import io
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("wrapper", os.path.join(HERE, "..", "do-work", "read-market-prices.py"))
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)

SOURCE = wrapper.load_source()
MARKET = {
    "id": "9001", "question": "Will the sample team win the sample cup?", "slug": "sample-cup",
    "conditionId": "0x1abc", "outcomes": "[\"Yes\", \"No\"]", "outcomePrices": "[\"0.6\", \"0.4\"]",
    "clobTokenIds": "[\"tok-yes\", \"tok-no\"]", "volumeNum": 1000.5, "liquidityNum": 50, "active": True, "closed": False,
}
BOOK = {"market": "0x1abc", "asset_id": "tok-yes", "bids": [{"price": "0.55", "size": "10"}, {"price": "0.5", "size": "5"}],
        "asks": [{"price": "0.65", "size": "7"}, {"price": "0.7", "size": "3"}]}


def fake(status, body, seen):
    def http(url, headers, timeout):
        seen.append({"url": url, "headers": headers, "timeout": timeout})
        return status, json.dumps(body).encode("utf-8")
    return http


class Seam(unittest.TestCase):
    def test_markets_are_normalized_and_the_request_comes_from_the_data_row(self):
        seen = []
        result = wrapper.read_markets({"limit": 3}, http=fake(200, [MARKET], seen))
        self.assertEqual(result["status"]["state"], "live")
        self.assertEqual(result["markets"][0]["outcomes"], ["Yes", "No"])
        self.assertEqual(result["markets"][0]["token_ids"], ["tok-yes", "tok-no"])
        self.assertTrue(seen[0]["url"].startswith(SOURCE["markets"]["base_url"] + SOURCE["markets"]["path"] + "?"))
        self.assertIn("limit=3", seen[0]["url"])
        self.assertIn("active=true", seen[0]["url"])

    def test_default_limit_comes_from_the_data_row(self):
        seen = []
        wrapper.read_markets({}, http=fake(200, [MARKET], seen))
        self.assertIn("limit=%d" % SOURCE["markets"]["default_limit"], seen[0]["url"])

    def test_user_agent_is_sent_and_names_no_old_brand(self):
        seen = []
        wrapper.read_markets({}, http=fake(200, [MARKET], seen))
        wrapper.read_order_book({"token_id": "tok-yes"}, http=fake(200, BOOK, seen))
        for call in seen:
            self.assertEqual(call["headers"]["User-Agent"], SOURCE["user_agent"])
            self.assertIn("trillion-workshop", call["headers"]["User-Agent"])
            self.assertEqual(call["headers"]["accept"], "application/json")

    def test_a_403_is_an_honest_empty_with_its_status(self):
        result = wrapper.read_markets({}, http=fake(403, {"title": "Access denied", "status": 403}, []))
        self.assertEqual(result["markets"], [])
        self.assertEqual(result["status"]["state"], "error")
        self.assertEqual(result["status"]["http_status"], 403)

    def test_a_request_that_gets_no_reply_says_so(self):
        def down(url, headers, timeout):
            raise OSError("no route")
        result = wrapper.read_markets({}, http=down)
        self.assertEqual(result["markets"], [])
        self.assertEqual(result["status"]["state"], "error")
        self.assertIn("no route", result["status"]["note"])
        book = wrapper.read_order_book({"token_id": "t"}, http=down)
        self.assertEqual(book["status"]["state"], "error")
        self.assertEqual(book["book"]["token_id"], "t")
        self.assertIn("no route", book["status"]["note"])

    def test_the_order_book_is_read_for_the_token_asked(self):
        seen = []
        result = wrapper.read_order_book({"token_id": " tok-yes "}, http=fake(200, BOOK, seen))
        self.assertIn("token_id=tok-yes", seen[0]["url"])
        self.assertTrue(seen[0]["url"].startswith(SOURCE["order_book"]["base_url"] + SOURCE["order_book"]["path"] + "?"))
        self.assertEqual(result["book"]["token_id"], "tok-yes")
        self.assertEqual(result["book"]["best_bid"], 0.55)
        self.assertEqual(result["book"]["best_ask"], 0.65)
        self.assertEqual(result["status"]["state"], "live")

    def test_an_unknown_token_is_an_honest_empty_book(self):
        result = wrapper.read_order_book({"token_id": "nope"}, http=fake(404, {"error": "No orderbook exists"}, []))
        self.assertEqual(result["status"]["state"], "error")
        self.assertEqual(result["status"]["http_status"], 404)
        self.assertEqual(result["book"]["bids"], [])

    def test_bad_requests_are_refused_with_words(self):
        for request in ({"limit": 0}, {"limit": 101}, {"limit": "5"}, {"limit": True}):
            with self.assertRaisesRegex(ValueError, "limit must be"):
                wrapper.read_markets(request, http=fake(200, [], []))
        with self.assertRaisesRegex(ValueError, "token_id is required"):
            wrapper.read_order_book({}, http=fake(200, BOOK, []))

    def test_main_prints_the_answer_as_the_last_line(self):
        out = io.StringIO()
        import contextlib
        with contextlib.redirect_stdout(out):
            code = wrapper.main(["x", "book"], stdin=io.StringIO(json.dumps({"token_id": "tok-yes"})), http=fake(200, BOOK, []))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue().strip().splitlines()[-1])["book"]["best_bid"], 0.55)
        self.assertEqual(wrapper.main(["x", "nonsense"]), 2)
        self.assertEqual(wrapper.main(["x", "markets"], stdin=io.StringIO("[1]")), 1)

    def test_every_row_runs_a_command_the_wrapper_has_and_only_the_bars_row_holds_a_credential(self):
        rows = json.load(open(os.path.join(HERE, "..", "tool-rows.json")))["records"]
        commands = set()
        for record in rows:
            invoke = record["payload"]["invoke"]
            command = invoke["argv"][-1]
            if command == "bars":
                self.assertEqual(invoke["credential_mounts"], [{"secret_name": "market-data-credentials", "fd": wrapper.CREDENTIAL_DESCRIPTOR}])
            else:
                self.assertNotIn("credential_mounts", invoke)
            self.assertTrue(invoke["internet"])
            commands.add(command)
        self.assertEqual(commands, set(wrapper.COMMANDS))


HELD = {"key_id": "held-key-id-0001", "secret": "held-secret-0001"}
FEED = {
    "url": "https://data.broker.example/v1/bars?adjust=none",
    "query": {"timeframe": "5Min", "limit": "120"},
    "query_names": ["symbols", "timeframe", "limit", "start"],
    "credential_injections": [
        {"field": "key_id", "placement": {"kind": "header", "name": "X-Example-Key"}},
        {"field": "secret", "placement": {"kind": "query", "name": "secret"}},
    ],
    "bars_at": "bars",
    "fields": {"timestamp": "t", "open": "o", "high": "h", "low": "l", "close": "c", "volume": "v"},
}
BARS = {"bars": {"BREAD": [{"t": "2026-01-02T15:00:00Z", "o": 10, "h": 11, "l": 9.5, "c": 10.5, "v": 300},
                           {"t": "2026-01-02T15:05:00Z", "o": 10.5, "h": 12, "l": 10, "c": 11.75, "v": 120}],
                 "ROLL": [{"t": "2026-01-02T15:00:00Z", "o": 4, "h": 4, "l": 4, "c": 4, "v": 1}]}}


class Bars(unittest.TestCase):
    def test_bars_are_read_with_the_feed_and_the_held_fields_where_the_feed_puts_them(self):
        seen = []
        result = wrapper.read_price_bars({"feed": FEED, "query": {"symbols": "BREAD,ROLL", "limit": "2"}}, http=fake(200, BARS, seen), held=HELD)
        url = seen[0]["url"]
        self.assertTrue(url.startswith("https://data.broker.example/v1/bars?adjust=none&"))
        for part in ("symbols=BREAD%2CROLL", "timeframe=5Min", "limit=2", "secret=held-secret-0001"):
            self.assertIn(part, url)
        self.assertNotIn("limit=120", url)
        self.assertEqual(seen[0]["headers"]["X-Example-Key"], "held-key-id-0001")
        self.assertEqual(seen[0]["headers"]["User-Agent"], SOURCE["user_agent"])
        self.assertEqual(result["status"]["state"], "live")
        self.assertEqual(result["status"]["bar_count"], 3)
        self.assertEqual(result["latest"], {"BREAD": 11.75, "ROLL": 4.0})
        self.assertNotIn("held-", json.dumps(result))

    def test_a_request_without_a_feed_or_with_names_the_feed_does_not_allow_is_refused_with_words(self):
        with self.assertRaisesRegex(ValueError, "no market-data feed was given, so nothing was read. Give feed:"):
            wrapper.read_price_bars({}, http=fake(200, BARS, []), held=HELD)
        with self.assertRaisesRegex(ValueError, "no market-data feed"):
            wrapper.read_price_bars({"feed": {**FEED, "fields": {"timestamp": "t"}}}, http=fake(200, BARS, []), held=HELD)
        with self.assertRaisesRegex(ValueError, "names the feed allows"):
            wrapper.read_price_bars({"feed": FEED, "query": {"password": "x"}}, http=fake(200, BARS, []), held=HELD)

    def test_a_held_value_without_a_field_the_feed_needs_is_refused_by_the_field_name_only(self):
        with self.assertRaises(ValueError) as caught:
            wrapper.read_price_bars({"feed": FEED}, http=fake(200, BARS, []), held={"key_id": "held-key-id-0001"})
        self.assertIn('field "secret"', str(caught.exception))
        self.assertNotIn("held-key-id-0001", str(caught.exception))

    def test_an_error_answer_or_no_answer_is_an_honest_empty_that_carries_no_held_value(self):
        refused = wrapper.read_price_bars({"feed": FEED}, http=fake(401, {"message": "unauthorized"}, []), held=HELD)
        self.assertEqual((refused["status"]["state"], refused["status"]["http_status"], refused["bars"]), ("error", 401, []))

        def down(url, headers, timeout):
            raise OSError("cannot connect to " + url)
        lost = wrapper.read_price_bars({"feed": FEED}, http=down, held=HELD)
        self.assertEqual(lost["status"]["state"], "error")
        self.assertNotIn("held-", json.dumps(lost))


if __name__ == "__main__":
    unittest.main()
