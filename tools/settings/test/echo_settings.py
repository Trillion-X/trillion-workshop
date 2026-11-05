"""A made-up program run under run-with-settings: answers its request with request_settings over its defaults."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))
import settings  # noqa: E402

DEFAULTS = {'fps': 24, 'colours': {'ink': '#000000', 'accent': '#ff0000'}, 'width': 1920, 'height': 1080}
request = json.loads(sys.stdin.read() or '{}')
try:
    print(json.dumps({**{k: v for k, v in request.items() if k != 'settings_record'},
                      'settings': settings.request_settings(request, DEFAULTS, folder='sample-tool')}))
except settings.SettingError as exc:
    print(json.dumps({'error': str(exc)}))
