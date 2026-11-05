"""Runs do-work/fetch_forum_posts.py with urllib's urlopen stood in for by a made-up archive.

usage: forum_archive.py <plan.json> <calls.jsonl>   (the request on standard input, as the script takes it)
plan.json maps an address the script asks for to {"status", "body"}; an address not in the plan answers {"data": []}.
Each address asked is appended to calls.jsonl. Every forum and post in a plan is made up.
"""
import io
import json
import os
import runpy
import sys
import urllib.error
import urllib.request

plan_path, calls_path = sys.argv[1:3]
plan = json.load(open(plan_path))


def urlopen(request, timeout=None):
    address = request.full_url
    with open(calls_path, "a") as calls:
        calls.write(json.dumps({"address": address, "agent": request.get_header("User-agent")}) + "\n")
    answer = plan.get(address, {"body": {"data": []}})
    if answer.get("status", 200) != 200:
        raise urllib.error.HTTPError(address, answer["status"], "made-up failure", {}, None)
    return io.BytesIO(json.dumps(answer["body"]).encode())


urllib.request.urlopen = urlopen
script = os.path.join(os.path.dirname(__file__), "..", "..", "do-work", "fetch_forum_posts.py")
sys.argv = [script]
runpy.run_path(script, run_name="__main__")
