"""The person's limits and reviewed pins as one row of their list:settings (record:setting:check-a-rendered-video~<scope_kind>~<scope_id>):
read from a file holding the row, or handed in a JSON request the way tools/settings/do-work/run-with-settings.mjs hands them. Made-up data only.
Run: python3 test/run_tests.py test_settings_row.py"""
import contextlib
import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'do-work'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_checks import LIMITS, Base, limits  # noqa: E402
from rendercheck import cli, config, jsonio, pins  # noqa: E402

ROW_ID = 'record:setting:check-a-rendered-video~film~sample-film'


def row(status='active', **settings):
    """The row as the shared reader's make_record writes it: settings as sorted-key JSON text."""
    return config.settings_reader().make_record('check-a-rendered-video', 'film', 'sample-film', settings, name='Limits of the sample film',
                                                tool='tool:check-a-rendered-video', source='made up for this test', status=status)


def answer(run):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = run()
    return rc, json.loads(buf.getvalue().strip().splitlines()[-1])


class SettingsRow(Base):
    def test_a_row_reads_as_its_limits_and_pins_the_same(self):
        jsonio.write(self.path('row.json'), row(limits=limits()))
        self.assertEqual(config.load(self.path('row.json')), limits())
        self.assertEqual(pins.check_pins(config.load(self.path('row.json'))), pins.check_pins(limits()))

    def test_the_value_alone_and_settings_as_an_object_read_the_same(self):
        jsonio.write(self.path('value.json'), row(limits=limits())['value'])
        self.assertEqual(config.load(self.path('value.json')), limits())
        held = row(limits=limits())
        held['value']['settings'] = {'limits': limits()}
        jsonio.write(self.path('object.json'), held)
        self.assertEqual(config.load(self.path('object.json')), limits())

    def test_a_row_for_another_tool_is_refused(self):
        other = row(limits=limits())
        other['value']['tool'] = 'tool:another-tool'
        jsonio.write(self.path('row.json'), other)
        with self.assertRaisesRegex(ValueError, 'not tool:check-a-rendered-video'):
            config.load(self.path('row.json'))

    def test_a_retired_row_is_refused(self):
        jsonio.write(self.path('row.json'), row(status='retired', limits=limits()))
        with self.assertRaisesRegex(ValueError, 'retired'):
            config.load(self.path('row.json'))

    def test_a_row_with_no_limits_is_refused(self):
        jsonio.write(self.path('row.json'), row(reviewed_pins={}))
        with self.assertRaisesRegex(ValueError, 'holds no limits'):
            config.load(self.path('row.json'))

    def test_pins_reads_the_reviewed_pins_from_the_row(self):
        now = pins.check_pins(limits())
        reviewed = dict(now, joins='0' * 64)
        jsonio.write(self.path('row.json'), row(limits=limits(), reviewed_pins=reviewed))
        rc, out = answer(lambda: cli.main(['pins', '--limits', self.path('row.json'), '--reviewed', self.path('row.json')]))
        self.assertEqual(rc, 0)
        self.assertEqual([c['check'] for c in out['result']['changed']], ['joins'])


class Request(Base):
    def run_request(self, req):
        return answer(lambda: cli.request_main(io.StringIO(json.dumps(req))))

    def test_pins_runs_on_the_settings_handed_in(self):
        now = pins.check_pins(limits())
        rc, out = self.run_request({'argv': ['pins'], 'settings_record': row(limits=limits(), reviewed_pins=dict(now, tempo='1' * 64)), 'settings_from': ROW_ID})
        self.assertEqual(rc, 0)
        self.assertEqual(out['result']['pins'], now)
        self.assertEqual([c['check'] for c in out['result']['changed']], ['tempo'])

    def test_the_requests_own_settings_lie_over_the_row(self):
        now = pins.check_pins(limits())
        rc, out = self.run_request({'argv': ['pins'], 'settings_record': row(limits=limits(), reviewed_pins=dict(now, tempo='1' * 64)),
                                    'settings': {'reviewed_pins': {'tempo': now['tempo']}}})
        self.assertEqual(rc, 0)
        self.assertEqual(out['result']['changed'], [])

    def test_a_named_id_not_read_through_the_door_is_refused(self):
        rc, out = self.run_request({'argv': ['pins'], 'settings_record': ROW_ID})
        self.assertEqual(rc, 2)
        self.assertIn('run-with-settings', out['error'])

    def test_a_command_that_needs_limits_is_refused_without_them(self):
        rc, out = self.run_request({'argv': ['pins']})
        self.assertEqual(rc, 2)
        self.assertIn('needs the person', out['error'])

    def test_limits_given_as_an_argument_are_refused(self):
        rc, out = self.run_request({'argv': ['pins', '--limits', LIMITS], 'settings': {'limits': limits()}})
        self.assertEqual(rc, 2)
        self.assertIn('as settings', out['error'])

    def test_inspect_eyes_needs_no_limits(self):
        jsonio.write(self.path('marks.json'), {'/x/a.jpg': [{'eye_open': [0.3, 0.2], 'mouth_open': 0.1}]})
        rc, out = self.run_request({'argv': ['inspect', 'eyes', self.path('marks.json')]})
        self.assertEqual(rc, 0)
        self.assertEqual(out['result']['all_eye_open'], [0.2])


if __name__ == '__main__':
    unittest.main()
