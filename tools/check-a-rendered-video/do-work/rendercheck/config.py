"""The person's limits: one JSON file with the checks to run and every number and word list they use. Nothing is shipped as a default."""
import json
import subprocess

from . import jsonio


FOLDER = 'check-a-rendered-video'
TOOL = 'tool:check-a-rendered-video'


def settings_reader():
    """The one shared settings reader, tools/settings/read-data/settings.py: beside this folder in a Workshop checkout, or packed at /opt/settings."""
    import sys
    from pathlib import Path
    for root in (Path(__file__).resolve().parents[3] / 'settings' / 'read-data', Path('/opt/settings/read-data')):
        if (root / 'settings.py').is_file():
            if str(root) not in sys.path:
                sys.path.insert(0, str(root))
            break
    import settings
    return settings


def _is_setting(data):
    if not isinstance(data, dict):
        return False
    if data.get('type') == 'record:setting' and isinstance(data.get('value'), dict):
        return True
    return 'settings' in data and 'scope_kind' in data and 'status' in data


def from_setting(data, key):
    """`settings[key]` of a list:settings row (the record records:read gives, or its value; its settings JSON text or an object),
    or `data` itself when it is not a row (a bare limits or pins file). The shared reader refuses a retired row or one for another tool."""
    if not _is_setting(data):
        return data
    reader = settings_reader()
    try:
        held = reader.settings_of(data, TOOL)
    except reader.SettingError as exc:
        raise ValueError(str(exc)) from None
    if not isinstance(held, dict) or not isinstance(held.get(key), dict):
        raise ValueError(f'the settings row holds no {key}: its settings has {sorted(held) if isinstance(held, dict) else type(held).__name__}')
    return held[key]


def load(path):
    """The limits as a dict: `frame`, `analysis`, and one section per check (named like its module: in_frame, joins, ...).
    The file is either the limits themselves or the person's list:settings row for this tool (record:setting:check-a-rendered-video~<scope_kind>~<scope_id>),
    whose settings.limits are the limits."""
    return from_setting(jsonio.read(path), 'limits')


def load_reviewed(path):
    """The person's reviewed pins ({check: pin}): a pins file, or settings.reviewed_pins of their list:settings row."""
    return from_setting(jsonio.read(path), 'reviewed_pins')


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
