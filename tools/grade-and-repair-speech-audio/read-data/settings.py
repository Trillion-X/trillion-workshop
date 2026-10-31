"""The person's settings: their microphone, room, loudness target and voice, read from one JSON file they give.

The tool carries no settings of its own. settings-keys.json lists every key with its meaning and type; load() refuses a file
that lacks one or holds a value of the wrong type, naming it, so no run silently uses a value the person did not give.
"""
import json
import os

KEYS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings-keys.json")))["keys"]
TYPES = {"number": (int, float), "integer": (int,), "string": (str,), "object": (dict,)}


def load(path):
    """The settings at `path`. Stops the run, naming each missing key and each key of the wrong type."""
    given = json.load(open(path))
    problems = [f"{key} is missing ({spec['meaning']})" for key, spec in KEYS.items() if key not in given]
    problems += [f"{key} must be a {spec['type']}" for key, spec in KEYS.items()
                 if key in given and (isinstance(given[key], bool) or not isinstance(given[key], TYPES[spec["type"]]))]
    if problems:
        raise SystemExit(f"{path}: the settings are not complete:\n  " + "\n  ".join(problems))
    return {key: given[key] for key in KEYS}
