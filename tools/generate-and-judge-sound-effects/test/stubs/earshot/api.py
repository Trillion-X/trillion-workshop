"""Stand-in earshot.api. A description's words that name a pitch ("low", "high") set the frequency it listens for;
match z is how close the file's brightest frequency is to it, so a test can say which candidate must win. Every call
is recorded in CALLS."""
import os

import numpy as np

from . import audio

CALLS = []
WANT_HZ = {'low': 200.0, 'high': 2000.0}


def _want(query):
    return next((hz for word, hz in WANT_HZ.items() if word in query.split()), 1000.0)


def _x(path, start=None, end=None):
    x = audio.load(path, mono=True)
    a = int((start or 0) * audio.SR)
    b = int(end * audio.SR) if end is not None else len(x)
    return x[a:b]


def _peak_hz(x):
    spectrum = np.abs(np.fft.rfft(x))
    return float(np.fft.rfftfreq(len(x), 1 / audio.SR)[int(np.argmax(spectrum))])


def match(path, query, alts=None, start=None, end=None):
    CALLS.append(('match', str(path), query))
    z = round(3.0 - abs(np.log2(max(_peak_hz(_x(path, start, end)), 1.0) / _want(query))), 2)
    return {'z': z, 'verdict': 'matches' if z > 1 else 'unclear', 'summary': f'z {z}', 'p_vs_alts': 0.5}


def realness(path, start=None, end=None):
    CALLS.append(('realness', str(path)))
    return {'p_real': 0.5, 'verdict': 'unsure', 'summary': 'stand-in'}


def measure(path, start=None, end=None, music=False, light=False):
    x = _x(path, start, end)
    rms = float(np.sqrt(np.mean(x ** 2)) + 1e-12)
    return {'lufs': round(20 * np.log10(rms), 1), 'peak_dbfs': round(20 * np.log10(np.abs(x).max() + 1e-12), 1),
            'attack_ms': 1.0, 'decay_ms': 10.0, 'centroid_hz': round(_peak_hz(x), 1), 'lra_lu': 3.0}


def describe(path, start=None, end=None, top=5):
    return {'summary': f'a tone near {round(_peak_hz(_x(path, start, end)))} Hz'}


def find(path, query, top=1, kind='event'):
    x = audio.load(path, mono=True)
    loud = np.nonzero(np.abs(x) > np.abs(x).max() * 0.5)[0]
    return {'segments': [{'start': loud[0] / audio.SR, 'end': loud[-1] / audio.SR, 'z': 2.0, 'kind': kind}]}


def ab(a, b, query=None):
    CALLS.append(('ab', str(a), str(b)))
    return {'summary': f'{os.path.basename(a)} against {os.path.basename(b)}'}


def rank(folders, query):
    files = sorted(os.path.join(f, n) for f in folders for n in os.listdir(f) if n.endswith('.wav'))
    scored = sorted(({'path': f, 'z': match(f, query)['z']} for f in files), key=lambda r: -r['z'])
    return {'results': scored, 'summary': f'{len(scored)} ranked'}


def compare(path, folder):
    return {'typical_z': 0.0, 'summary': 'stand-in'}


def critique(path, video=None):
    CALLS.append(('critique', str(path), str(video)))
    x = audio.load(path, mono=True)
    lufs = round(20 * np.log10(float(np.sqrt(np.mean(x ** 2))) + 1e-12), 1)
    metrics = [{'name': 'loudness', 'value': lufs, 'status': 'ok' if -30 < lufs < -5 else 'low'}]
    return {'verdict': 'stand-in', 'score': 1.0, 'in_range': sum(m['status'] == 'ok' for m in metrics), 'scored': len(metrics),
            'critical_issues': [], 'major_issues': [], 'metrics': metrics}


def timeline(path, video=None, cues=None, fresh=False):
    return {'sync': {'cues': len(cues or []), 'video': str(video)}}
