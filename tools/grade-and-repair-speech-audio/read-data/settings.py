"""The person's settings: their microphone, room, loudness target and voice, read from one JSON file they give.

The tool carries no settings of its own. settings-keys.json lists every key with its meaning and type; load() refuses a file
that lacks one or holds a value of the wrong type, naming it, so no run silently uses a value the person did not give.
--settings-record names instead the person's record:setting rows as records:read answers them, laid over in order (a
person's, then a film's); tools/settings/read-data/settings.py reads each, refusing a wrong type, tool or a retired row.
"""
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FOLDER, TOOL = "grade-and-repair-speech-audio", "tool:grade-and-repair-speech-audio"
SETTINGS_RECORD = os.path.join(os.path.dirname(os.path.dirname(HERE)), "settings", "read-data", "settings.py")
KEYS = json.load(open(os.path.join(HERE, "settings-keys.json")))["keys"]
TYPES = {"number": (int, float), "integer": (int,), "string": (str,), "object": (dict,)}


def load(path, given=None):
    """The settings at `path` (or `given`). Stops the run, naming each missing key and each key of the wrong type."""
    given = json.load(open(path)) if given is None else given
    keys = KEYS
    problems = [f"{key} is missing ({spec['meaning']})" for key, spec in keys.items() if key not in given]
    problems += [f"{key} must be a {spec['type']}" for key, spec in keys.items()
                 if key in given and (isinstance(given[key], bool) or not isinstance(given[key], TYPES[spec["type"]]))]
    if problems:
        raise SystemExit(f"{path}: the settings are not complete:\n  " + "\n  ".join(problems))
    return {key: given[key] for key in keys}


def load_records(paths):
    """The settings of the person's record:setting rows saved at `paths`, each laid over the one before it."""
    spec = importlib.util.spec_from_file_location("workshop_settings", SETTINGS_RECORD)
    reader, given = importlib.util.module_from_spec(spec), {}
    spec.loader.exec_module(reader)
    for path in paths:
        try:
            if (row := reader.chosen(path, FOLDER)) is None:
                raise reader.SettingError(f"it holds no row of {FOLDER}: give record:setting:{FOLDER}~<scope_kind>~<scope_id>")
            given = reader.lay_over(given, reader.settings_of(row, TOOL))
        except reader.SettingError as error:
            raise SystemExit(f"{path}: {error}") from None
    return load(" + ".join(paths), given)


def add_arguments(ap):
    one = ap.add_mutually_exclusive_group(required=True)
    one.add_argument("--settings", help="the person's settings file (see read-data/settings-keys.json)")
    one.add_argument("--settings-record", action="append", help="the person's record:setting row as records:read answers it; "
                     "give it again to lay a film's row over the person's")


def from_arguments(a):
    return load(a.settings) if a.settings else load_records(a.settings_record)
