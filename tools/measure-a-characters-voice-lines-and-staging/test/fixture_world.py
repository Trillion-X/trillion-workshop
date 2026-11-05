"""A made-up show for the tests: "The Lighthouse Hour", whose keeper talks low and whose parrot (the keeper's own voice,
raised) talks high. Every id, title, comment, number and setting here is invented for these tests.

The show's data folder holds catalog.tsv and voice/; its youtube folder holds flat/, captions/, comments/ and measure/,
the layout the scripts read.
"""
import json
import os
import subprocess
import sys

TOOL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOLDER = 'measure-a-characters-voice-lines-and-staging'

SETTINGS = {
    'character_label': 'parrot', 'embed_min_pitch_hz': 180.0, 'embed_pitch_ratio': 1.4, 'gate_pitch_ratio': 1.6,
    'gate_max_hz': 220.0, 'voice_cosine_min': 0.5, 'batch_format_order': ['episode', 'side'], 'audio_file': '{id}.wav',
    'pitch_run_band_low_hz': 200.0, 'pitch_run_band_high_hz': 600.0,
    'series_prefixes': {'behind the lamp': 'extra'}, 'compilation_words': ['best of', 'marathon'],
    'side_pattern': 'parrot|song|trailer',
    'caption_turn_pitch_ratio': 1.6,
    'mention_pattern': 'parrot|\\bpolly\\b',
    'codebook': {'pleasure': 'funny|laugh', 'absence': 'miss(ed)? (him|the parrot)'},
    'terms': {'cracker': 'crackers?', 'storm': '\\bstorm\\b(?! drain)'},
    'opening_seconds': 20, 'closing_seconds': 10, 'stripped_ids': ['vid-c'], 'compare_from_month': '203001',
    'compare_to_month': '203012', 'lowest_from_year': '2030',
}


def setting_row(settings=None, folder=FOLDER, status='active'):
    """The person's settings row as records:read answers it (settings kept as JSON text, as list:settings does)."""
    return {'id': f'record:setting:{folder}~piece~lighthouse-parrot', 'type': 'record:setting',
            'value': {'name': 'The parrot of the made-up lighthouse show', 'tool': 'tool:find-when-a-character-speaks',
                      'scope_kind': 'piece', 'scope_id': 'lighthouse-parrot',
                      'settings': json.dumps(SETTINGS if settings is None else settings, sort_keys=True),
                      'from': 'made-up@0000000', 'status': status}}


def write(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(value if isinstance(value, str) else json.dumps(value))
    return path


def json3(lines):
    """A caption file from [(start s, duration s, text)]."""
    return {'events': [{'tStartMs': int(a * 1000), 'dDurationMs': int(d * 1000), 'segs': [{'utf8': t}]} for a, d, t in lines]
            + [{'tStartMs': 0, 'dDurationMs': 0}]}


def catalog_file(data):
    rows = [('vid-a', 'episode', '20300105', '1000', '1.5', '1800', 'Fog'), ('vid-b', 'side', '20300201', '500', '0.5', '600', 'Tools'),
            ('vid-c', 'episode', '20300301~', '3000', '0.5', '1700', 'Gulls')]
    lines = ['id\tkind\tformat\tdate\tviews\tbaseline\tx_baseline\tdur\tlikes\tcomments\ttitle']
    lines += [f'{i}\tvideo\t{f}\t{d}\t{v}\t1\t{x}\t{dur}\t\t\t{t}' for i, f, d, v, x, dur, t in rows]
    return write(os.path.join(data, 'catalog.tsv'), '\n'.join(lines) + '\n')


def run(script, request=None, *argv):
    """Runs one of the tool's scripts with the request on standard input (a show script with argv); returns the process."""
    return subprocess.run([sys.executable, '-I', os.path.join(TOOL, script), *argv], capture_output=True, text=True,
                          input=None if request is None else request if isinstance(request, str) else json.dumps(request))


def last(proc):
    """The {"result": ...} the script printed last."""
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return json.loads(proc.stdout.strip().splitlines()[-1])['result']


def refused(proc):
    """The {"error": ...} a refused request printed last."""
    assert proc.returncode == 2, proc.stdout + proc.stderr
    return json.loads(proc.stdout.strip().splitlines()[-1])['error']
