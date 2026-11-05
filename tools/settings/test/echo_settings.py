"""A made-up program run under run-with-settings: answers its request with its settings laid over its defaults."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))
from settings import settings_of  # noqa: E402

DEFAULTS = {'fps': 24, 'colours': {'ink': '#000000', 'accent': '#ff0000'}, 'width': 1920, 'height': 1080}
request = json.loads(sys.stdin.read() or '{}')
print(json.dumps({**request, 'settings': settings_of(request, DEFAULTS)}))
