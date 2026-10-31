#!/usr/bin/env python3
"""A provider command that needs no account and no model: one solid-colour PNG per prompt.

It is the smallest provider there is, for checking that the chain works end to end and as the shape a person's own
provider follows. A real provider (a hosted model's caller or a local model's program) is the same contract with a
different command: it reads the request and writes the answer, and nothing else about generate_images.py changes.

  placeholder_image_provider.py --request-json REQUEST --output-json ANSWER

The same prompt always gives the same colour. The picture is returned inline as a data: URL; generate_images.py writes
it to a file. Standard library only.
"""
import argparse
import base64
import json
import struct
import sys
import zlib
from datetime import datetime, timezone
from pathlib import Path

SIZE = 256


def png_chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def solid_png(width, height, rgb):
    """A minimal valid 8-bit truecolour PNG of one solid colour."""
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    rows = (b"\x00" + bytes(rgb) * width) * height
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", zlib.compress(rows, 9)) + png_chunk(b"IEND", b"")


def colour_for_prompt(prompt):
    """The same prompt, the same colour: three bytes of a checksum of its words."""
    checksum = zlib.crc32(prompt.encode("utf-8"))
    return ((checksum >> 16) & 255, (checksum >> 8) & 255, checksum & 255)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request_json).read_text(encoding="utf-8"))
    picture = solid_png(SIZE, SIZE, colour_for_prompt(str(request.get("prompt") or "")))
    answer = {
        "format": "image/png",
        "provider_ref": "placeholder-image-provider",
        "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "output_artifact_refs": [{
            "src": "data:image/png;base64," + base64.b64encode(picture).decode("ascii"),
            "media_type": "image/png",
            "byte_length": len(picture),
        }],
    }
    Path(args.output_json).write_text(json.dumps(answer, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
