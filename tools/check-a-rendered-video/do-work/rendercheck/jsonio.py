"""JSON files read and written with the file closed."""
import json


def read(path):
    with open(path) as f:
        return json.load(f)


def write(path, data, **kw):
    with open(path, 'w') as f:
        json.dump(data, f, **kw)
