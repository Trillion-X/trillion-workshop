"""Stand-in PIL.Image: a made-up picture is a file of words, and its picture is those words."""
from pathlib import Path


class Picture:
    def __init__(self, text):
        self.text = text
        self.side = None

    def convert(self, _):
        return self

    def thumbnail(self, size):
        self.side = size


def open(path):
    return Picture(Path(path).read_text())
