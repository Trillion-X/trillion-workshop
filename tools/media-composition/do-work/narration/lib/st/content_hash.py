"""Use Trillion's existing BLAKE3 byte-identity owner for narration cache keys."""
import os
from pathlib import Path
import shutil
import subprocess

OWNER = Path(__file__).resolve().parents[2] / 'identity.mjs'


class content_hash:
    def __init__(self, initial=b''):
        self.parts = [initial]

    def update(self, value):
        self.parts.append(value)

    def hexdigest(self):
        node = os.environ.get('TRILLION_NARRATION_NODE') or shutil.which('node')
        if not node:
            raise RuntimeError('The declared Node dependency is unavailable for the byte-identity owner.')
        result = subprocess.run([node, str(OWNER)], input=b''.join(self.parts), capture_output=True, timeout=60)
        if result.returncode:
            raise RuntimeError('The byte-identity owner failed: ' + result.stderr.decode()[-300:])
        digest = result.stdout.decode().strip()
        if len(digest) != 64 or any(letter not in '0123456789abcdef' for letter in digest):
            raise RuntimeError('The byte-identity owner returned an invalid result.')
        return digest
