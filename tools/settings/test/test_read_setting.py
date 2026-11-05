"""The shared settings reader, on made-up settings rows."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

from read_setting import SettingRefused, parse_setting_id, setting_id, setting_of, settings_of  # noqa: E402

ROW = {
    'id': 'record:setting:sort-a-pantry~person~sample-cook',
    'type': 'record:setting',
    'value': {'name': 'pantry sort', 'tool': 'sort-a-pantry', 'scope_kind': 'person', 'scope_id': 'sample-cook',
              'settings': json.dumps({'shelves': 3}), 'from': 'tools/pantry/settings.json@0000000', 'status': 'active'},
}


class SettingIds(unittest.TestCase):
    def test_id_is_folder_scope_kind_and_scope_id(self):
        self.assertEqual(setting_id('sort-a-pantry', 'film', 'kitchen-2026'), 'record:setting:sort-a-pantry~film~kitchen-2026')
        self.assertEqual(parse_setting_id('record:setting:sort-a-pantry~account~main'), {'tool': 'sort-a-pantry', 'scope_kind': 'account', 'scope_id': 'main'})

    def test_bad_parts_are_refused_with_what_to_fix(self):
        for args in [('Sort', 'person', 'a'), ('sort', 'team', 'a'), ('sort', 'person', 'A B'), ('sort', 'person', '')]:
            with self.assertRaises(SettingRefused):
                setting_id(*args)
        for bad in ['record:check:x', 'record:setting:a~b', 'record:setting:a~person~b~c', None]:
            with self.assertRaises(SettingRefused):
                parse_setting_id(bad)


class ReadingSettings(unittest.TestCase):
    def test_a_row_gives_its_settings_parsed_from_json_text(self):
        self.assertEqual(settings_of({'settings_record': ROW}, 'sort-a-pantry'), {'shelves': 3})
        got = setting_of(ROW)
        self.assertEqual((got['scope_kind'], got['scope_id'], got['status']), ('person', 'sample-cook', 'active'))

    def test_a_row_may_hold_an_object_and_may_come_from_a_file(self):
        row = {**ROW, 'value': {**ROW['value'], 'settings': {'shelves': 4}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'row.json'
            path.write_text(json.dumps(row))
            self.assertEqual(settings_of({'settings_record': str(path)}, 'sort-a-pantry'), {'shelves': 4})

    def test_inline_settings_serve_samples_and_tests(self):
        self.assertEqual(settings_of({'settings': {'a': 1}}, 'x'), {'a': 1})
        self.assertIsNone(settings_of({}, 'x', required=False))
        with self.assertRaisesRegex(SettingRefused, 'record:setting:x~'):
            settings_of({}, 'x')

    def test_another_tools_row_an_absent_row_and_a_retired_row_are_refused(self):
        with self.assertRaisesRegex(SettingRefused, 'not of other-tool'):
            settings_of({'settings_record': ROW}, 'other-tool')
        with self.assertRaisesRegex(SettingRefused, 'no setting'):
            settings_of({'settings_record': {**ROW, 'value': None}})
        with self.assertRaisesRegex(SettingRefused, 'retired'):
            settings_of({'settings_record': {**ROW, 'value': {**ROW['value'], 'status': 'retired'}}})

    def test_a_value_that_disagrees_with_its_id_or_is_not_json_is_refused(self):
        with self.assertRaisesRegex(SettingRefused, 'scope_id'):
            setting_of({**ROW, 'value': {**ROW['value'], 'scope_id': 'someone-else'}})
        with self.assertRaisesRegex(SettingRefused, 'not JSON'):
            setting_of({**ROW, 'value': {**ROW['value'], 'settings': '{nope'}})
        with self.assertRaisesRegex(SettingRefused, 'type'):
            setting_of({**ROW, 'type': 'record:check'})
        with self.assertRaisesRegex(SettingRefused, 'not a file'):
            setting_of('/nowhere/row.json')


if __name__ == '__main__':
    unittest.main()
