#!/usr/bin/env python3
"""Premix a motion film's soundtrack from its cue sheet: one music bed (its gain shaped over time: ducked under the
voice, set or lifted in named windows), the voice lines at their offsets, and every sound effect at the time of the
picture event it belongs to, then the loudness pass the film's settings name. One JSON request on stdin, one JSON
answer as the last line printed.

Request:
  cue_sheet        the film's cue sheet (an object), or cue_sheet_file (a path to one). Accepted shapes:
                   {DUR, VO?, voiced? | VOICED?, cues: [[t, sound, gain_db], ...]} or a plain list of
                   {t, sound, gain_db}; settings.duration gives DUR when the sheet has none.
  film_folder      the film's folder ({film} in the settings' path templates)
  sound_folder     the folder holding music/ and palette/ ({sound} in the settings' path templates)
  settings_record  the film's row of list:settings (record:setting:motion-film-template~film~<film>): an id read
                   through the records door by tools/settings do-work/run-with-settings.mjs, or the record itself
  settings         settings laid over the row's (an object)
  run              false (default): answer the ffmpeg commands only, reading and writing nothing.
                   true: run them here (needs ffmpeg) and write the soundtrack.

Everything that belongs to one film (its music file and start, the gain windows, fades, filter chains, loudness
target and limiter) is the film's settings; the defaults below are only the format's file layout.
"""
from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
for candidate in (HERE.parents[2] / 'settings' / 'read-data', Path('/opt/settings/read-data')):
    if (candidate / 'settings.py').exists():
        sys.path.insert(0, str(candidate))
        break
import settings as settings_reader  # noqa: E402

DEFAULTS = {
    'duration': None,
    'music': None,
    'gain': {'base': 0.0, 'duck': 0.0, 'duck_pad': [0.12, 0.22], 'windows': [], 'steps_per_second': 20, 'time_format': '.2f'},
    'voice': {'files': '{film}/assets/vo/l{n:02d}.wav', 'chain': 'aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms}'},
    'cues': {'palette': '{sound}/palette', 'chain': 'aresample=48000,aformat=channel_layouts=stereo,volume={gain}dB,adelay={ms}|{ms}'},
    'mix': None,
    'after_mix': None,
    'loudness': {'method': 'linear-two-pass', 'loudnorm': 'I=-14.5:TP=-1.5:LRA=20', 'target_i': -14.5, 'limit_db': -1.9},
    'out': None,
    'work': None,
}
METHODS = ('none', 'gain-then-limit', 'linear-two-pass')


class Refusal(Exception):
    pass


def read_cue_sheet(request: dict, settings: dict) -> dict:
    sheet = request.get('cue_sheet')
    if sheet is None and request.get('cue_sheet_file'):
        sheet = json.loads(Path(request['cue_sheet_file']).read_text())
    if sheet is None:
        raise Refusal('Give cue_sheet (the film\'s audio/cues.json as an object) or cue_sheet_file (its path).')
    if isinstance(sheet, list):
        sheet = {'cues': sheet}
    dur = settings.get('duration') if settings.get('duration') is not None else sheet.get('DUR')
    if dur is None:
        raise Refusal('The cue sheet has no DUR: give the film\'s length in seconds as settings.duration.')
    cues = []
    for cue in sheet.get('cues', []):
        if isinstance(cue, dict):
            cues.append((cue['t'], cue['sound'], cue['gain_db']))
        elif isinstance(cue, (list, tuple)) and len(cue) == 3:
            cues.append(tuple(cue))
        else:
            raise Refusal(f'A cue must be [t, sound, gain_db] or {{t, sound, gain_db}}; got {cue!r}.')
    voiced = sheet.get('voiced', sheet.get('VOICED', []))
    return {'DUR': float(dur), 'VO': list(sheet.get('VO', [])), 'voiced': [list(v) for v in voiced], 'cues': cues}


def gain_at(t: float, gain: dict, voiced: list) -> float:
    """The music bed's gain in dB at time t. Windows are read in order: the first matching window that sets a gain
    (set, or ramp from one gain to another across the window) decides; otherwise the base, the duck while a voice
    line is heard (padded by duck_pad either side), and every matching window that adds."""
    def inside(w):
        lo, hi = w.get('from'), w.get('to')
        if lo is not None and t < lo:
            return False
        if hi is not None and (t > hi if w.get('to_inclusive') else t >= hi):
            return False
        return True
    for w in gain['windows']:
        if ('set' in w or 'ramp' in w) and inside(w):
            if 'set' in w:
                return w['set']
            a, b = w['ramp']
            return a + (b - a) * (t - w['from']) / (w['to'] - w['from'])
    pre, post = gain['duck_pad']
    heard = any(a - pre <= t <= b + post for a, b in voiced)
    g = gain['base'] + (gain['duck'] if heard else 0.0)
    for w in gain['windows']:
        if 'add' in w and inside(w):
            g += w['add']
    return g


def gain_expression(dur: float, gain: dict, voiced: list) -> tuple[str, list]:
    """The gain as an ffmpeg volume expression: piecewise constant, sampled steps_per_second times a second."""
    steps = gain['steps_per_second']
    pts = [(round(i / steps, 2), gain_at(i / steps, gain, voiced)) for i in range(0, int(dur * steps) + 1)]
    segs = []
    for t, g in pts:
        if not segs or g != segs[-1][1]:
            segs.append([t, g])
    fmt = gain['time_format']
    expr = f"{10 ** (segs[-1][1] / 20):.5f}"
    for i in range(len(segs) - 2, -1, -1):
        expr = f"if(lt(t,{segs[i + 1][0]:{fmt}}),{10 ** (segs[i][1] / 20):.5f},{expr})"
    return expr, segs


class Planned(Exception):
    """Raised by the plan recorder once the commands that need no measurement are recorded."""


class PlanRecorder:
    """Stands in for subprocess when only the plan is asked: records each ffmpeg command instead of running it, and
    stops at the first measurement, whose answer the later commands need."""
    def __init__(self):
        self.commands = []

    def run(self, argv, capture_output=False, **_):
        self.commands.append([str(a) for a in argv])
        if capture_output:
            raise Planned()


def mix(request: dict, settings: dict, subprocess) -> dict:
    """The premix of the film's old audio/mix.py, with what it fixed taken from the settings. `subprocess` is the real
    module when run, or a PlanRecorder."""
    sheet = read_cue_sheet(request, settings)
    DUR, CUES, VO, VOICED = sheet['DUR'], sheet['cues'], sheet['VO'], sheet['voiced']
    FILM = Path(request.get('film_folder', '.'))
    SOUND = Path(request.get('sound_folder', str(FILM.parent.parent / 'sound')))
    places = {'film': str(FILM), 'sound': str(SOUND)}
    PAL = Path(settings['cues']['palette'].format(**places))
    loud = settings['loudness']
    if loud.get('method') not in METHODS:
        raise Refusal(f'settings.loudness.method must be one of {", ".join(METHODS)}.')
    music = settings.get('music')
    inputs, filters, labels, segs = [], [], [], []
    if music:
        if not music.get('file') or not music.get('chain'):
            raise Refusal('settings.music needs file (a path template) and chain (its ffmpeg filter chain).')
        start = float(music.get('start', 0.0))
        expr, segs = gain_expression(DUR, settings['gain'], VOICED)
        values = {**places, 'DUR': DUR, 'start': start, 'end': start + DUR, 'gain_expr': expr,
                  'fade_out': music.get('fade_out', 0.0), 'fade_out_at': DUR - music.get('fade_out', 0.0),
                  'read_to': DUR + music.get('read_tail', 0.0), 'bed': music.get('bed', 0.0)}
        MUSIC = values['file'] = music['file'].format(**values)
        inputs = ['-i', str(MUSIC)]
        if music.get('input_args'):
            inputs = [a.format(**values) for a in music['input_args']]
        filters.append('[0:a]' + music['chain'].format(**values) + '[m]')
        labels.append('[m]')
    for i, t in enumerate(VO):
        if t is None:             # a cut line: its take stays on disk so the file numbers hold
            continue
        n = inputs.count('-i')
        inputs += ['-i', settings['voice']['files'].format(**places, n=i + 1, i=i)]
        ms = int(max(0, t) * 1000)
        filters.append(f'[{n}:a]' + settings['voice']['chain'].format(ms=ms) + f'[v{i}]')
        labels.append(f'[v{i}]')
    first = inputs.count('-i')
    for j, (t, name, g) in enumerate(CUES):
        inputs += ['-i', str(PAL / f'{name}.wav')]
        ms = int(max(0, t) * 1000)
        filters.append(f'[{first + j}:a]' + settings['cues']['chain'].format(ms=ms, gain=g) + f'[s{j}]')
        labels.append(f'[s{j}]')
    if not labels:
        raise Refusal('Nothing to mix: the settings name no music and the cue sheet has no voice lines or cues.')
    if settings['mix'] is None:
        filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,atrim=0:{DUR}[pre]")
    else:
        filters.append(''.join(labels) + settings['mix'].format(inputs=len(labels), DUR=DUR) + '[pre]')
    if settings.get('after_mix'):
        filters[-1] = filters[-1][:-len('[pre]')] + '[mixed]'
        filters.append('[mixed]' + settings['after_mix'] + '[pre]')

    out = FILM / 'assets/soundtrack.wav'
    raw = FILM / 'audio/premix-raw.wav'
    if settings.get('out'):
        out = Path(settings['out'].format(**places))
    if settings.get('work'):
        raw = Path(settings['work'].format(**places))
    answer = {'out': str(out), 'DUR': DUR, 'method': loud['method'], 'gain_segments': segs,
              'counts': {'voice_lines': sum(t is not None for t in VO), 'effects': len(CUES),
                         'recordings': len({c[1] for c in CUES}), 'inputs': len(labels)}}
    if loud['method'] == 'none':
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(filters), '-map', '[pre]',
                        '-ar', '48000', '-ac', '2', str(out)], check=True)
        if not isinstance(subprocess, PlanRecorder):
            print('wrote', out, f'{DUR} s,', len(CUES), 'effects from', len(set(c[1] for c in CUES)), 'recordings')
        return answer
    subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(filters), '-map', '[pre]',
                    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', str(raw)], check=True)

    if loud['method'] == 'gain-then-limit':
        # two-pass level: measure, then one static gain to the target and a peak limiter
        meas = subprocess.run(['ffmpeg', '-nostdin', '-v', 'info', '-i', str(raw), '-af', loud['measure'], '-f', 'null', '-'],
                              capture_output=True, text=True).stderr
        m = json.loads(meas[meas.rindex('{'):meas.rindex('}') + 1])
        gain = loud['target_i'] - float(m['input_i'])
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', '-i', str(raw), '-af', f"volume={gain:.2f}dB,{loud['limiter']}",
                        '-ar', '48000', '-ac', '2', str(out)], check=True)
        raw.unlink()
        print('wrote', out, f'{DUR} s,', len(CUES), 'effects from', len(set(c[1] for c in CUES)), 'recordings')
        return {**answer, 'measured_i': m['input_i'], 'gain_db': round(gain, 2)}

    LOUDNORM = 'loudnorm=' + loud['loudnorm']
    def measure(extra=''):
        r = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', str(raw), '-af', extra + LOUDNORM + ':print_format=json',
                            '-f', 'null', '-'], capture_output=True, text=True)
        return json.loads(re.findall(r'\{[^{}]*\}', r.stderr)[-1])

    # Loudness: two passes, linear (one gain), with a true-peak limiter first so linear mode is never refused.
    m = measure()
    gain = loud['target_i'] - float(m['input_i'])
    lim = f"volume={gain:.2f}dB,alimiter=limit={10 ** (loud['limit_db'] / 20):.4f}:attack=1:release=60:level=false,volume={-gain:.2f}dB,"
    m2 = measure(lim)
    af = (lim + f"{LOUDNORM}:linear=true:measured_I={m2['input_i']}:measured_TP={m2['input_tp']}:"
          f"measured_LRA={m2['input_lra']}:measured_thresh={m2['input_thresh']}:offset={m2['target_offset']}:print_format=json")
    r = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-y', '-i', str(raw), '-af', af, '-ar', '48000', '-ac', '2', str(out)],
                       capture_output=True, text=True, check=True)
    res = json.loads(re.findall(r'\{[^{}]*\}', r.stderr)[-1])
    print('loudnorm', res['normalization_type'], 'in', m['input_i'], 'LUFS -> out', res['output_i'], 'LUFS, TP', res['output_tp'], 'LRA', res['output_lra'])
    raw.unlink()
    print('wrote', out, f'{DUR} s,', len(CUES), 'effects from', len(set(c[1] for c in CUES)), 'recordings')
    return {**answer, 'measured_i': m['input_i'], 'normalization_type': res['normalization_type'], 'output_i': res['output_i'],
            'output_tp': res['output_tp'], 'output_lra': res['output_lra']}


def plan(request: dict, settings: dict) -> dict:
    """The commands only: the premix, and the first measurement when the loudness method measures."""
    recorder = PlanRecorder()
    try:
        answer = mix(request, settings, recorder)
    except Planned:
        answer = None
    if answer is None:   # stopped at the measurement: work the answer out again without running anything
        settings_none = {**settings, 'loudness': {'method': 'none'}}
        answer = mix(request, settings_none, PlanRecorder())
        answer['method'] = settings['loudness']['method']
    commands = recorder.commands
    return {**answer, 'premix': commands[0], 'measure': commands[1] if len(commands) > 1 else None}


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or '{}')
        settings = settings_reader.request_settings(request, copy.deepcopy(DEFAULTS), folder='motion-film-template')
        if request.get('run'):
            import subprocess as real
            answer = mix(request, settings, real)
        else:
            answer = plan(request, settings)
        if request.get('settings_from'):
            answer['settings_from'] = request['settings_from']
        print(json.dumps({'result': answer}))
        return 0
    except (Refusal, settings_reader.SettingError) as e:
        print(json.dumps({'error': str(e)}))
        return 1
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError) as e:
        print(json.dumps({'error': f'{type(e).__name__}: {e}. Check the cue sheet, the settings and that ffmpeg and the named files exist.'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
