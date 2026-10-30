#!/usr/bin/env python3
"""Stands in for Ollama in tests: answers /api/chat from the moments it is shown, by simple word rules, and logs each request.

  fake_ollama.py REQUEST_LOG     prints its port on the first line, then serves until stopped.

Rules: a moment with "money" is money talk (0.8); one with "gardens" is gardening tips (0.7); one with "um uh" is filler (0.05).
A moment with "forgotten" is left out of the answer when more than one moment is asked about, so the tool must ask again alone.
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = sys.argv[1]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        user = body["messages"][1]["content"]
        asked = re.findall(r"^\[(\d+)\] (.*)$", user.split("Moments:\n", 1)[1], re.M)
        with open(LOG, "a") as handle:
            handle.write(json.dumps({"model": body["model"], "asked": [int(i) for i, _ in asked], "vocabulary": "- money_talk:" in user}) + "\n")
        answers, new = [], {}
        for ident, text in [(i, t.lower()) for i, t in asked]:
            if "forgotten" in text and len(asked) > 1:
                continue
            if "money" in text:
                answers.append({"id": int(ident), "buckets": ["Money Talk"], "relevance": 0.8})
                new["Money Talk"] = "talk about money"
            elif "gardens" in text:
                answers.append({"id": int(ident), "buckets": ["gardening_tips", "plants", "soil", "water"], "relevance": 0.7})
                new["gardening_tips"] = "how to look after a garden"
            else:
                answers.append({"id": int(ident), "buckets": ["filler"], "relevance": 0.05})
        reply = json.dumps({"message": {"role": "assistant", "content": json.dumps({"moments": answers, "new_buckets": new})}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)


server = HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
