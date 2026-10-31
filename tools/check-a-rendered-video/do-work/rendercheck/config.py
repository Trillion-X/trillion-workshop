"""The person's limits: one JSON file with the checks to run and every number and word list they use. Nothing is shipped as a default."""
import json
import subprocess

from . import jsonio


def load(path):
    """The limits file as a dict: `frame`, `analysis`, and one section per check (named like its module: in_frame, joins, ...)."""
    return jsonio.read(path)


def blake3_hex(data):
    """BLAKE3 hex of bytes (the one hashing owner for this tool's identities)."""
    try:
        import blake3
        return blake3.blake3(data).hexdigest()
    except ImportError:
        return subprocess.run(['b3sum', '--no-names'], input=data, capture_output=True, check=True).stdout.decode().strip()


def fingerprint(cfg):
    """BLAKE3 identity of a limits file's canonical JSON (audit only: gating pins each check on its own, see pins.py)."""
    return blake3_hex(json.dumps(cfg, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())
