#!/usr/bin/env python3
"""Synthetic list owner for runner tests; the local test server supplies all rows."""
import json
import os
import sys
import urllib.error
import urllib.request

payload = json.load(sys.stdin)
request = urllib.request.Request(sys.argv[1], data=json.dumps({"params": {"arguments": {"input": payload}}}).encode(),
                                 headers={"content-type": "application/json",
                                          "authorization": "Bearer " + os.environ.get(sys.argv[2], "")}, method="POST")
try:
    with urllib.request.urlopen(request, timeout=5) as response:
        page = json.load(response)["result"]["structuredContent"]
except urllib.error.HTTPError as error:
    print(json.dumps({"error": {"status": error.code}}))
    sys.exit(1)
print(json.dumps(page))
