"""Writes a JSON file: the first argument is the path, the second the JSON text."""
import json
import sys

with open(sys.argv[1], "w") as handle:
    json.dump(json.loads(sys.argv[2]), handle)
