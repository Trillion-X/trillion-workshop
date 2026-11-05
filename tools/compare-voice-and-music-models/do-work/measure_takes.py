
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
Run with python3.
"""
import json
import re
import subprocess
import sys
import numpy as np
import soundfile as sf
import sys, pathlib; sys.path.insert(0, str(next(p for p in pathlib.Path(__file__).resolve().parents if (p / 'capabilities.json').is_file()) / 'tools/place-capabilities')); import whisper_here as mlx_whisper  # mlx_whisper where the place has it, else faster-whisper or openai-whisper

PITCH = r'''
import sys, json, numpy as np, parselmouth
s = parselmouth.Sound(sys.argv[1]).convert_to_mono()
f = s.to_pitch_ac(pitch_floor=60, pitch_ceiling=300).selected_array['frequency']
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


WORDS_DIR = __file__.rsplit('/', 2)[0] + '/work'
_tools = {}


def voice_tools(reference):
    if not _tools:
        import torch
        from pyannote.audio import Inference, Model
        from transformers import AutoFeatureExtractor, Wav2Vec2ForSequenceClassification
        _tools['emb'] = Inference(Model.from_pretrained('pyannote/wespeaker-voxceleb-resnet34-LM'), window='whole')
        _tools['fx'] = AutoFeatureExtractor.from_pretrained('dima806/english_accents_classification')
        _tools['acc'] = Wav2Vec2ForSequenceClassification.from_pretrained('dima806/english_accents_classification')
        _tools['torch'] = torch
        _tools['reference'] = embed(reference)
    return _tools


def embed(path):
    import librosa
    y, _ = librosa.load(path, sr=16000, mono=True)
    return _tools['emb']({'waveform': _tools['torch'].from_numpy(y)[None], 'sample_rate': 16000})


def same_voice_and_accent(path, reference):
    import librosa
    t = voice_tools(reference)
    e = embed(path)
    cos = float(np.dot(e, t['reference']) / (np.linalg.norm(e) * np.linalg.norm(t['reference'])))
    y, _ = librosa.load(path, sr=16000, mono=True)
    probs = []
    for a in range(0, max(1, len(y) - 16000 * 5 + 1), 16000 * 5):
        x = t['fx'](y[a:a + 16000 * 5], sampling_rate=16000, return_tensors='pt')
        with t['torch'].no_grad():
            probs.append(t['torch'].softmax(t['acc'](**x).logits, -1)[0].numpy())
    eng = next(int(k) for k, v in t['acc'].config.id2label.items() if v == 'england')
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


def measure(path, line):
    y, sr = sf.read(path, always_2d=True)
    y = y.mean(1)
    res = mlx_whisper.transcribe(path, path_or_hf_repo='mlx-community/whisper-large-v3-turbo', word_timestamps=True,
                                 language='en', initial_prompt=line.get('hear_prompt'))
    words = [w for s in res['segments'] for w in s['words']]
    stem = path.rsplit('/', 1)[-1].rsplit('.', 1)[0]
    with open(f"{WORDS_DIR}/{stem}.words.json", 'w') as f:  # for narrator/tools/voice_qc.py
        json.dump({'words': [{'text': w['word'].strip(), 'start': w['start'], 'end': w['end']} for w in words]}, f)
    win = int(0.01 * sr)
    env = 20 * np.log10(np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same')) + 1e-9)
    quiet = env < -45
    loud = np.where(~quiet)[0]
    first, last = loud[0], loud[-1]
    pauses, i = [], first
    while i < last:
        if quiet[i]:
            j = i
            while j < last and quiet[j]:
                j += 1
            if j - i >= int(0.12 * sr):
                a, b = i / sr, j / sr
                before = [w['word'].strip() for w in words if w['end'] <= a + 0.15][-1:] or ['']
                after = [w['word'].strip() for w in words if w['start'] >= b - 0.15][:1] or ['']
                pauses.append({'after': before[0], 'before': after[0], 'at': round(a, 2), 's': round(b - a, 2)})
            i = j
        else:
            i += 1
    speech_s = (last - first) / sr
    silent_s = sum(p['s'] for p in pauses)
    close = next((w for w in words if norm(w['word'])[:1] == [line['vowel_check']['word']]), words[0])
    pitch = json.loads(subprocess.run(['/tmp/pm-venv/bin/python', '-c', PITCH, path, str(close['start']),
                                       str(close['end'])], capture_output=True, text=True, check=True).stdout)
    heard = ' '.join(w['word'].strip() for w in words)
    ref, hyp = norm(line['script']), norm(heard)
    same, england = same_voice_and_accent(path, line['voice_reference'])
    return {'take': path.rsplit('/', 1)[-1], 'same_voice': same, 'p_england': england, 'seconds': round(len(y) / sr, 2), 'speech_seconds': round(speech_s, 2),
            'words_per_s': round(len(ref) / speech_s, 2), 'articulation_wps': round(len(ref) / (speech_s - silent_s), 2),
            'longest_pause_s': max((p['s'] for p in pauses), default=0), 'pauses': pauses, **pitch,
            'word_errors': wer(ref, hyp), 'script_words': len(ref), 'heard': heard}


if __name__ == '__main__':
    line = json.load(open(sys.argv[1]))
    for p in sys.argv[2:]:
        print(json.dumps(measure(p, line), ensure_ascii=False))
