#!/usr/bin/env python3
"""Keep an explicit person's name for one observed voice cluster."""

import json
import sys
from datetime import datetime, timezone


def value_of(row):
    return row.get("value", row.get("payload", row)) if isinstance(row, dict) else {}


def main():
    request = json.load(sys.stdin)
    voice_id = request["voice_id"].strip()
    name = request["person_name"].strip()
    known = {value_of(row).get("voice_id") for row in request.get("known_voices", [])}
    if voice_id not in known:
        raise ValueError("Analyze a recording containing this voice before naming it.")
    if not name:
        raise ValueError("Give the person's name.")
    binding = {"kind": "media-person-binding", "id": voice_id, "voice_id": voice_id,
               "person_name": name, "named_at": datetime.now(timezone.utc).isoformat()}
    print(json.dumps({"binding": binding, "voice_id": voice_id, "person_name": name}, separators=(",", ":")))


if __name__ == "__main__":
    main()
