"""A stand-in for an OpenAI-compatible chat server, for the extract tests. It prints its port, then answers /chat/completions.

For every "[part N] ... title: T ..." header in the request it answers three rows: one whose quote is the part's first eight words
as said, one whose quote is words three to ten with the case and punctuation changed and one word wrong (placed by closeness), and
one whose quote was never said (dropped). A part whose title holds "broken" gets an HTTP 500 the first time each run asks for it.
"""
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

asked = set()


def rows_for(user):
    rows = []
    pieces = re.split(r"^\[part (\d+)\] ", user, flags=re.M)[1:]
    for number, body in zip(pieces[0::2], pieces[1::2]):
        header, _, text = body.partition("\n")
        words = text.split()
        rows.append({"part": int(number), "statement": f"Idea one of {header.split('title: ')[1].split(' |')[0]}.", "kind": "tactic",
                     "domains": ["testing"], "speaker": None, "quote": " ".join(words[:8]), "why": None})
        bent = [w.upper() + "," for w in words[2:10]]
        bent[3] = "WRONGWORD"
        rows.append({"part": int(number), "statement": "Idea two.", "kind": "insight", "domains": ["testing"], "speaker": "host",
                     "quote": " ".join(bent), "why": "because"})
        rows.append({"part": int(number), "statement": "Made up.", "kind": "lesson", "domains": [], "speaker": None,
                     "quote": "this sentence was never said by anyone", "why": None})
    return rows


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        user = body["messages"][-1]["content"]
        if "broken" in user and user not in asked:
            asked.add(user)
            self.send_response(500)
            self.end_headers()
            return
        content = "<think>thinking</think>```json\n" + json.dumps({"rows": rows_for(user)}) + "\n```"
        answer = {"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": len(user.split()), "completion_tokens": 30}}
        data = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
