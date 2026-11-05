#!/usr/bin/env python3
"""measure_takes.py <line.json> <take.wav> [...] [--settings-record F] [--words-dir D] [--words-from D]: the numbers the person's ear is compared with, per take, as one JSON line each.

  pauses      every silence of 120 ms or more inside the speech (10 ms RMS below -45 dBFS), with the words on
              each side (word times from mlx-whisper large-v3-turbo)
  rate        words per second over the whole take, and over voiced time only (articulation rate)
  pitch       F0 5th-95th percentile in Hz and its span in semitones (Praat, via /tmp/pm-venv parselmouth)
  stt         the words whisper heard, and word errors against the script (Levenshtein over normalised words)
  vowel       onset F2 and voiced length of the line's `vowel_check.word` (for "Close": British /əʊ/ starts near
              1300-1500 Hz, American /oʊ/ near 900-1000 Hz)
  same_voice  cosine similarity of a speaker embedding (pyannote wespeaker-voxceleb-resnet34-LM) to the line's
              `voice_reference` take; two different sentences of the same Kokoro voice scored 0.86 (2026-10-20)
  accent      P(england) from dima806/english_accents_classification (wav2vec2; labels us, england, indian,
              australia, canada), mean over 5 s windows
Run with python3. Every model, level and length above is a setting (say_a_line_in_kokoro.DEFAULTS, over which the
person's settings row goes). Each take's whisper word times are written to <words dir>/<take>.words.json (default: the
take's folder's work/), for a word-by-word check of the take. --words-from <dir> measures with the word times already
in <dir>/<take>.words.json instead of hearing the take again; --no-voice-models leaves same_voice and the accent out.
The last line is {"result": {"takes": [...]}} or {"error": "what to change"}.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import say_a_line_in_kokoro as kt  # noqa: E402  (settings, the speech-to-text engine and refusals, shared)

PITCH = r'''
import sys, json, numpy as np, parselmouth
s = parselmouth.Sound(sys.argv[1]).convert_to_mono()
f = s.to_pitch_ac(pitch_floor=float(sys.argv[4]), pitch_ceiling=float(sys.argv[5])).selected_array['frequency']
f = f[f > 0]
lo, hi = np.percentile(f, 5), np.percentile(f, 95)
a, b = float(sys.argv[2]), float(sys.argv[3])
fm = s.extract_part(a, b).to_formant_burg(max_number_of_formants=5, maximum_formant=5000)
p = s.extract_part(a, b).to_pitch()
t = [x for x in np.arange(0.01, b - a, 0.01) if p.get_value_at_time(x) == p.get_value_at_time(x)]
f2 = [fm.get_value_at_time(2, x) for x in t[:max(1, len(t) // 4)]]
print(json.dumps({"f0_p5": round(lo), "f0_p95": round(hi), "span_st": round(12 * np.log2(hi / lo), 1),
                  "vowel_onset_f2": round(float(np.nanmean(f2))) if t else None,
                  "vowel_ms": round((t[-1] - t[0]) * 1000) if t else None}))
'''


_tools = {}


def voice_tools(reference, cfg=kt.DEFAULTS):
    if not _tools:
        import torch
        from pyannote.audio import Inference, Model
        from transformers import AutoFeatureExtractor, Wav2Vec2ForSequenceClassification
        _tools['emb'] = Inference(Model.from_pretrained(cfg['speaker_model']), window='whole')
        _tools['fx'] = AutoFeatureExtractor.from_pretrained(cfg['accent_model'])
        _tools['acc'] = Wav2Vec2ForSequenceClassification.from_pretrained(cfg['accent_model'])
        _tools['torch'] = torch
        _tools['reference'] = embed(reference)
    return _tools


def embed(path):
    import librosa
    y, _ = librosa.load(path, sr=16000, mono=True)
    return _tools['emb']({'waveform': _tools['torch'].from_numpy(y)[None], 'sample_rate': 16000})


def same_voice_and_accent(path, reference, cfg=kt.DEFAULTS):
    import librosa
    t = voice_tools(reference, cfg)
    e = embed(path)
    cos = float(np.dot(e, t['reference']) / (np.linalg.norm(e) * np.linalg.norm(t['reference'])))
    y, _ = librosa.load(path, sr=16000, mono=True)
    probs, w = [], int(16000 * cfg['accent_window_s'])
    for a in range(0, max(1, len(y) - w + 1), w):
        x = t['fx'](y[a:a + w], sampling_rate=16000, return_tensors='pt')
        with t['torch'].no_grad():
            probs.append(t['torch'].softmax(t['acc'](**x).logits, -1)[0].numpy())
    eng = next(int(k) for k, v in t['acc'].config.id2label.items() if v == cfg['accent_label'])
    return round(cos, 3), round(float(np.mean(probs, 0)[eng]), 2)


def norm(s):
    return re.sub(r"[^a-z' ]", ' ', s.lower().replace('-', ' ')).split()


def wer(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
    return d[-1]


def pauses_of(y, sr, words, quiet_db=-45, least_s=0.12, slack_s=0.15):
    """(pauses, first loud sample, last loud sample): every silence of least_s or more inside the speech (10 ms RMS
    below quiet_db), with the word heard just before it and just after it."""
    win = int(0.01 * sr)
    env = 20 * np.log10(np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same')) + 1e-9)
    quiet = env < quiet_db
    loud = np.where(~quiet)[0]
    if not len(loud):
        raise kt.Refusal('the take is silent: nothing in it is louder than quiet_db')
    first, last = loud[0], loud[-1]
    pauses, i = [], first
    while i < last:
        if quiet[i]:
            j = i
            while j < last and quiet[j]:
                j += 1
            if j - i >= int(least_s * sr):
                a, b = i / sr, j / sr
                before = [w['word'].strip() for w in words if w['end'] <= a + slack_s][-1:] or ['']
                after = [w['word'].strip() for w in words if w['start'] >= b - slack_s][:1] or ['']
                pauses.append({'after': before[0], 'before': after[0], 'at': round(a, 2), 's': round(b - a, 2)})
            i = j
        else:
            i += 1
    return pauses, first, last


def heard_words(path, line, cfg, words_from=None):
    """The words whisper heard in the take, with their times: heard now, or read from <words_from>/<take>.words.json."""
    stem = path.rsplit('/', 1)[-1].rsplit('.', 1)[0]
    if words_from:
        try:
            saved = json.load(open(f"{words_from}/{stem}.words.json"))
        except OSError:
            raise kt.Refusal(f'{words_from}/{stem}.words.json is not there: --words-from names the folder of the takes\' words') from None
        return [{'word': w['text'], 'start': w['start'], 'end': w['end']} for w in saved['words']]
    res = kt.transcriber(cfg).transcribe(path, path_or_hf_repo=cfg['whisper_model'], word_timestamps=True,
                                         language='en', initial_prompt=line.get('hear_prompt'))
    return [w for s in res['segments'] for w in s['words']]


def pitch_of(path, a, b, cfg):
    py = cfg.get('parselmouth_python') or ('/tmp/pm-venv/bin/python' if os.path.exists('/tmp/pm-venv/bin/python') else sys.executable)
    done = subprocess.run([py, '-c', PITCH, path, str(a), str(b), str(cfg['pitch_floor_hz']), str(cfg['pitch_ceiling_hz'])],
                          capture_output=True, text=True)
    if done.returncode != 0:
        raise kt.Refusal(f'the pitch measure needs parselmouth in {py} (python3 -m pip install praat-parselmouth, or set '
                         f'parselmouth_python): {done.stderr.strip().splitlines()[-1:] or ""}')
    return json.loads(done.stdout)


def measure(path, line, cfg=kt.DEFAULTS, words_dir=None, words_from=None, voice_models=True):
    import soundfile as sf
    y, sr = sf.read(path, always_2d=True)
    y = y.mean(1)
    words = heard_words(path, line, cfg, words_from)
    if not words:
        raise kt.Refusal(f'whisper heard no words in {path}')
    stem = path.rsplit('/', 1)[-1].rsplit('.', 1)[0]
    words_dir = words_dir or os.path.join(os.path.dirname(os.path.abspath(path)), 'work')
    if not words_from:
        os.makedirs(words_dir, exist_ok=True)
        with open(f"{words_dir}/{stem}.words.json", 'w') as f:  # for a word-by-word check of the take
            json.dump({'words': [{'text': w['word'].strip(), 'start': w['start'], 'end': w['end']} for w in words]}, f)
    pauses, first, last = pauses_of(y, sr, words, cfg['quiet_db'], cfg['pause_least_s'], cfg['pause_word_slack_s'])
    speech_s = (last - first) / sr
    silent_s = sum(p['s'] for p in pauses)
    close = next((w for w in words if norm(w['word'])[:1] == [line['vowel_check']['word']]), words[0])
    pitch = pitch_of(path, close['start'], close['end'], cfg)
    heard = ' '.join(w['word'].strip() for w in words)
    ref, hyp = norm(line['script']), norm(heard)
    voice = {}
    if voice_models:
        same, accent = same_voice_and_accent(path, line['voice_reference'], cfg)
        voice = {'same_voice': same, f"p_{cfg['accent_label']}": accent}
    return {'take': path.rsplit('/', 1)[-1], **voice, 'seconds': round(len(y) / sr, 2), 'speech_seconds': round(speech_s, 2),
            'words_per_s': round(len(ref) / speech_s, 2), 'articulation_wps': round(len(ref) / (speech_s - silent_s), 2),
            'longest_pause_s': max((p['s'] for p in pauses), default=0), 'pauses': pauses, **pitch,
            'word_errors': wer(ref, hyp), 'script_words': len(ref), 'heard': heard}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('line')
    ap.add_argument('takes', nargs='+')
    ap.add_argument('--settings-record')
    ap.add_argument('--words-dir')
    ap.add_argument('--words-from')
    ap.add_argument('--no-voice-models', action='store_true')
    a = ap.parse_args(argv)
    try:
        cfg = kt.settings(a.settings_record)
        line = kt.read_line(a.line)
        if 'vowel_check' not in line or (not a.no_voice_models and 'voice_reference' not in line):
            raise kt.Refusal('the line needs vowel_check.word, and voice_reference unless --no-voice-models')
        for p in a.takes:
            if not os.path.isfile(p):
                raise kt.Refusal(f'{p} is not there: pass the takes to measure')
        rows = []
        for p in a.takes:
            rows.append(measure(p, line, cfg, a.words_dir, a.words_from, not a.no_voice_models))
            print(json.dumps(rows[-1], ensure_ascii=False), flush=True)
    except kt.Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    print(json.dumps({'result': {'takes': rows}}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
