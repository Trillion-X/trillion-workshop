"""Test helper: runs read-data/settings.py on the made-up row on standard input and prints what it answers."""
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('settings', Path(__file__).resolve().parent.parent / 'read-data' / 'settings.py')
settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settings)

given = json.loads(sys.stdin.read())
id_, value = given['id'], given['value']


def code_of(call):
    try:
        call()
    except settings.SettingError as error:
        return error.code
    return None


refusals = {
    'missing': code_of(lambda: settings.read_settings(lambda type_, id__: None, id_)),
    'not_active': code_of(lambda: settings.settings_of({**value, 'status': 'retired'}, id_)),
    'other_tool': code_of(lambda: settings.settings_of(value, id_, tool='other-tool')),
    'bad_id': code_of(lambda: settings.parse_setting_id('record:setting:x~film')),
    'bad_settings': code_of(lambda: settings.settings_of({**value, 'settings': '[1]'}, id_)),
}
row = settings.setting_row('sample-tool', 'film', 'kitchen-short', value['settings'], name=value['name'], from_=value['from'])
read = settings.read_settings(lambda type_, id__: value if (type_, id__) == ('record:setting', id_) else None, id_, tool='sample-tool')
print(json.dumps({'settings': read, 'row': row, 'refusals': refusals}))
