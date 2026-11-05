#!/usr/bin/env python3
"""say_a_line_in_kokoro.py <line.json> <voice> <out.wav> [--settings-record F [--film ID]]: one narration line in Kokoro, said the natural way.

The line is data (example: test/fixtures/narration-line.json): `units`, `pause_after`, `inner_most`, `script`.
  - Each unit is one generation. Kokoro has no context across generations, so a unit never splits a sentence.
  - Pronunciation goes in the unit text as misaki markup, [word](/IPA/), with misaki's British symbols (lang 'b':
    Q = /əʊ/, so "Close" is /klˈQs/). A word is never slowed or time-stretched to fix how it sounds.
  - A silence the model makes inside a unit (an ellipsis) is kept, but shortened to `inner_most` seconds when it is
    longer. Only silent samples are removed. `inner_most` is one number for every unit, or a list with one cap per unit
    (a longer cap for the unit with the ellipsis, so the model's other in-phrase pauses stay short).
  - Units are joined by the `pause_after` silences. Speech is never stretched.
An earlier take (its say.txt) did the opposite: it stacked [pause 0.6] on "...", which measured 1.40 s of
silence, and it slowed the vowel of a hand-written /klˈoːs/.
Run with python3 (mlx-audio 0.5.8, misaki 0.9.4).

This module is also the one definition the other voice A/B scripts share (say_a_line_in_a_cloned_voice.py and
measure_takes.py import it): the line, units, pauses and silence handling; the person's settings (`--settings-record`,
a list:settings row read by the one reader, tools/settings/read-data/settings.py, for --film, the person or the account, over DEFAULTS); the speech-to-text engine;
and refusals, printed as a last line {"error": "what to change"}. A take made prints {"result": {...}} last.
`--take-rows <settings record>` prints the A/B takes of the settings as render_takes.sh reads them.
"""
import argparse
import json
import sys
from pathlib import Path

FOLDER = 'compare-voice-and-music-models'
# What the scripts use when the person's settings row does not say otherwise: the values the 2026-10-20 A/B ran with.
DEFAULTS = {
    'kokoro_model': 'mlx-community/Kokoro-82M-bf16',
    'kokoro_sample_rate': 24000,
    'kokoro_speed': 1.0,
    'edge_db': -45,
    'clone_takes': 3,
    'clone_engines': {},  # engines added to say_a_line_in_a_cloned_voice.ENGINES: {name: [model, takes the reference's words]}
    'clone_reference': None,
    'whisper_model': 'mlx-community/whisper-large-v3-turbo',
    'whisper_here_dir': None,
    'quiet_db': -45,
    'pause_least_s': 0.12,
    'pause_word_slack_s': 0.15,
    'pitch_floor_hz': 60,
    'pitch_ceiling_hz': 300,
    'parselmouth_python': None,
    'speaker_model': 'pyannote/wespeaker-voxceleb-resnet34-LM',
    'accent_model': 'dima806/english_accents_classification',
    'accent_label': 'england',
    'accent_window_s': 5,
    'clean_command': None,
    'master_command': 'showtime voice master',
    'ticks_command': None,
    'measure_glob': None,
    'takes': [
        {'work': 'synthetic-2c278db27507', 'name': '2 Kokoro bm_lewis', 'maker': 'kokoro', 'voice': 'bm_lewis'},
        {'work': 'qwen3', 'name': '3 Qwen3-TTS clone', 'maker': 'clone', 'engine': 'qwen3'},
        {'work': 'pocket', 'name': '4 Pocket TTS clone', 'maker': 'clone', 'engine': 'pocket'},
        {'work': 'chatterbox', 'name': '5 Chatterbox Turbo clone', 'maker': 'clone', 'engine': 'chatterbox'},
        {'work': 'synthetic-4ae1cb8ef177', 'name': '6 Kokoro bm_george', 'maker': 'kokoro', 'voice': 'bm_george'},
        {'work': 'kokoro-bm_fable', 'name': '7 Kokoro bm_fable', 'maker': 'kokoro', 'voice': 'bm_fable'},
    ],
}

EDGE_DB = -45  # a unit's own leading/trailing silence below this level is trimmed before the set pause is added


class Refusal(Exception):
    pass


def scopes_for(film=None):
    """The scopes a setting is looked for in, most specific first: this film (when named), the person, the account."""
    return ([('film', film)] if film else []) + [('person', 'me'), ('account', 'main')]


def settings(given=None, film=None):
    """DEFAULTS with the person's settings over them. `given` is the settings_record: the list:settings row
    record:setting:compare-voice-and-music-models~<scope_kind>~<scope_id> as records:read gives it, its value, a list of
    them, or the path of a JSON file of any of those. It is read by the one settings reader, tools/settings/read-data/
    settings.py: the first of this film, the person and the account that has a row; a lone value with no id is read as given."""
    if given is None:
        return json.loads(json.dumps(DEFAULTS))
    root = next((p for p in Path(__file__).resolve().parents if (p / 'capabilities.json').is_file()), None)
    reader = root / 'tools' / 'settings' / 'read-data' / 'settings.py' if root else None
    if reader is None or not reader.is_file():
        raise Refusal('a settings record was given, but tools/settings/read-data/settings.py is not in this Workshop '
                      'checkout: update the checkout, or run without --settings-record to use the defaults')
    import importlib.util
    spec = importlib.util.spec_from_file_location('workshop_settings', reader)
    rows = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rows)
    try:
        record = rows.chosen(given, FOLDER, scopes_for(film))
        if record is None:
            lone = rows.chosen(given, FOLDER)  # one record given: read as it is only when it names no scope
            value = (lone or {}).get('value', lone or {})
            if lone is None or lone.get('id') or value.get('scope_kind'):
                said = lone.get('id') or f"{value.get('scope_kind')} {value.get('scope_id')}" if lone else 'nothing'
                raise Refusal(f'the settings record is for {said}, not for {" or ".join(" ".join(s) for s in scopes_for(film))}: '
                              'pass --film with the film it is for')
            record = lone
        found = rows.settings_of(record)
    except (ValueError, OSError) as e:
        raise Refusal(f'the settings record cannot be read: {e}') from None
    if found is not None and not isinstance(found, dict):
        raise Refusal('the settings record holds no object of settings: its settings field is a JSON object')
    return {**json.loads(json.dumps(DEFAULTS)), **(found or {})}


def transcriber(cfg):
    """mlx_whisper where the place has it, else the place's whisper_here (faster-whisper or openai-whisper), whose folder
    the settings name in whisper_here_dir. Both answer mlx_whisper.transcribe's shape."""
    if cfg.get('whisper_here_dir'):
        sys.path.insert(0, str(cfg['whisper_here_dir']))
        try:
            import whisper_here
            return whisper_here
        except ImportError:
            raise Refusal(f"whisper_here_dir {cfg['whisper_here_dir']} holds no whisper_here.py: name the folder that has it") from None
    try:
        import mlx_whisper
        return mlx_whisper
    except ImportError:
        raise Refusal('needs speech to text: python3 -m pip install -U mlx-whisper on Apple silicon, or name a folder holding '
                      'whisper_here.py (faster-whisper or openai-whisper) as whisper_here_dir in the settings') from None


def read_line(path):
    try:
        line = json.load(open(path))
    except OSError:
        raise Refusal(f'{path} is not there: pass the narration line as JSON (units, pause_after, inner_most, script)') from None
    except json.JSONDecodeError as e:
        raise Refusal(f'{path} is not JSON ({e}): pass the narration line as JSON') from None
    missing = [k for k in ('units', 'pause_after', 'inner_most', 'script') if not isinstance(line, dict) or k not in line]
    if missing:
        raise Refusal(f'{path} has no {", ".join(missing)}: a line is units, pause_after, inner_most and script')
    if len(line['units']) != len(line['pause_after']):
        raise Refusal('one pause_after per unit')
    if isinstance(line['inner_most'], list) and len(line['inner_most']) != len(line['units']):
        raise Refusal('one inner_most per unit')
    return line


def envelope_db(y, sr):
    import numpy as np
    win = int(0.01 * sr)
    return 20 * np.log10(np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same')) + 1e-9)


def trim(y, sr, edge_db=EDGE_DB):
    import numpy as np
    loud = np.where(envelope_db(y, sr) > edge_db)[0]
    if not len(loud):
        return y
    a, b = max(0, loud[0] - int(0.02 * sr)), min(len(y), loud[-1] + int(0.04 * sr))
    return y[a:b]


def cap_inner(y, sr, inner_most, edge_db=EDGE_DB):
    import numpy as np
    quiet, keep, i, most = envelope_db(y, sr) < edge_db, np.ones(len(y), bool), 0, int(inner_most * sr)
    while i < len(y):
        if quiet[i]:
            j = i
            while j < len(y) and quiet[j]:
                j += 1
            if j - i > most:
                cut = (j - i) - most
                keep[i + (j - i - cut) // 2: i + (j - i - cut) // 2 + cut] = False
            i = j
        else:
            i += 1
    return y[keep]


def join(units, line, sr, edge_db=EDGE_DB):
    """units: one audio array per unit -> the take: each unit trimmed, inner silences capped, set pauses between."""
    import numpy as np
    caps = line['inner_most'] if isinstance(line['inner_most'], list) else [line['inner_most']] * len(units)
    parts = []
    for y, pause, cap in zip(units, line['pause_after'], caps):
        parts += [cap_inner(trim(y, sr, edge_db), sr, cap, edge_db), np.zeros(int(pause * sr), np.float32)]
    return np.concatenate(parts)


def lang_of(voice):
    """Kokoro names a voice by its accent first: 'b' British (bm_lewis), 'a' American (af_heart). The G2P must match it,
    or an American voice is given British phonemes. The narrator's takes (bm_*) keep lang 'b' exactly as before."""
    return voice[0] if voice[:1] in ('a', 'b') else 'b'


def take_rows(cfg):
    """The settings' A/B takes as render_takes.sh reads them: <work name>|<final name>|<script> <argument>."""
    rows = []
    for take in cfg['takes']:
        if take.get('maker') == 'kokoro' and take.get('voice'):
            rows.append(f"{take['work']}|{take['name']}|say_a_line_in_kokoro.py {take['voice']}")
        elif take.get('maker') == 'clone' and take.get('engine'):
            rows.append(f"{take['work']}|{take['name']}|say_a_line_in_a_cloned_voice.py {take['engine']}")
        else:
            raise Refusal(f'take {take!r} is not a kokoro take with a voice or a clone take with an engine')
        if '|' in take['work'] + take['name'] or '/' in take['work'] + take['name']:
            raise Refusal(f"take {take['work']!r}: a work name or a final name holds no | or /")
    return rows


def chain(cfg):
    """The four lines render_takes.sh reads: the clean, master and ticks commands and the measure glob (empty: none)."""
    return [str(cfg.get(k) or '').replace('\n', ' ') for k in ('clean_command', 'master_command', 'ticks_command', 'measure_glob')]


def say_line(line, voice, cfg, load_model=None):
    import numpy as np
    if load_model is None:
        try:
            from mlx_audio.tts.utils import load_model
        except ImportError:
            raise Refusal('needs mlx-audio: python3 -m pip install -U mlx-audio misaki numpy soundfile, on Apple silicon') from None
    model = load_model(cfg['kokoro_model'])
    sr = cfg['kokoro_sample_rate']
    units = [np.concatenate([np.array(r.audio, dtype=np.float32) for r in
                             model.generate(text, voice=voice, speed=cfg['kokoro_speed'], lang_code=lang_of(voice), split_pattern=r'\n+')])
             for text in line['units']]
    return join(units, line, sr, cfg['edge_db']), sr


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('line', nargs='?')
    ap.add_argument('voice', nargs='?')
    ap.add_argument('out', nargs='?')
    ap.add_argument('--settings-record')
    ap.add_argument('--film', help='the film the settings row is for (scope film); the person and account rows are read too')
    ap.add_argument('--take-rows', metavar='SETTINGS_RECORD', help='print the A/B takes of these settings, one per line')
    ap.add_argument('--chain', metavar='SETTINGS_RECORD', help='print the clean, master and ticks commands and the measure glob')
    a = ap.parse_args(argv)
    try:
        if a.chain is not None:
            print('\n'.join(chain(settings(None if a.chain in ('', '-') else a.chain, a.film))))
            return 0
        if a.take_rows is not None:
            print('\n'.join(take_rows(settings(None if a.take_rows in ('', '-') else a.take_rows, a.film))))
            return 0
        if not (a.line and a.voice and a.out):
            raise Refusal('pass <line.json> <voice> <out.wav>, the voice a Kokoro voice name such as bm_lewis')
        cfg = settings(a.settings_record, a.film)
        line = read_line(a.line)
        y, sr = say_line(line, a.voice, cfg)
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    import soundfile as sf
    sf.write(a.out, y, sr, subtype='PCM_24')
    print(json.dumps({'result': {'take': a.out, 'voice': a.voice, 'model': cfg['kokoro_model'],
                                 'seconds': round(len(y) / sr, 2), 'sample_rate': sr}}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
