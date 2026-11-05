#!/usr/bin/env python3
"""say_a_line_in_a_cloned_voice.py <line.json> <engine> <out.wav> [--takes N] [--ref wav --ref-text txt] [--settings-record F [--film ID]]: one narration line in a
voice-cloning model, cloned from the narrator's own voice (the settings' clone_reference, or --ref: for example two other narrator
sentences in Kokoro bm_lewis, ending on a sentence end), so the timbre stays and only the model's rhythm and
intonation change.

Same line data, units, pauses and inner-pause ceiling as say_a_line_in_kokoro.py. Each unit is made N times (best of N); the take kept is
the one whose mlx-whisper transcript has the fewest word errors against the unit's words, then the one whose length is
nearest the median of the N (an outlier length is a rushed or dragged take). Speech is never stretched.
Engines (all run by mlx-audio 0.5.8 with python3):
  qwen3       mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16 (Apache-2.0), reference audio + its exact words
  chatterbox  mlx-community/synthetic-b198f86bcd39-8bit (Resemble Chatterbox Turbo, MIT), reference audio
  pocket      mlx-community/pocket-tts (Kyutai Pocket TTS, CC-BY-4.0), reference audio
The settings' clone_engines add others ({name: [model, takes the reference's words]}).
Writes <out>.units.json (what each unit's kept take was heard as) beside the take, and prints a last line
{"result": {...}} or {"error": "what to change"}. Clone only a voice the person owns or has the speaker's consent for.
"""
import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import say_a_line_in_kokoro as kt  # noqa: E402  (read_line, join: one definition of units, pauses and silence handling)

# engine -> (model, takes the reference's exact words too)
ENGINES = {
    'qwen3': ('mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16', True),
    'chatterbox': ('mlx-community/synthetic-b198f86bcd39-8bit', False),
    'pocket': ('mlx-community/pocket-tts', False),
}


def plain(unit):
    return re.sub(r'\[([^\]]+)\]\(/[^)]*/\)', r'\1', unit)


def words(s):
    return re.sub(r"[^a-z' ]", ' ', s.lower().replace('-', ' ')).split()


def errors(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
    return d[-1]


def best_of(cands):
    """The candidate kept: fewest word errors, then length nearest the median of all of them."""
    import numpy as np
    med = float(np.median([len(c['y']) for c in cands]))
    best = min(cands, key=lambda c: (c['err'], abs(len(c['y']) - med)))
    return best


def say_units(line, model, extra, hear, sr, takes, edge_db=kt.EDGE_DB, work=None):
    """(the take's units kept, the log): each unit made `takes` times by model.generate and heard by hear(wav path)."""
    import numpy as np
    import soundfile as sf
    work = Path(work or tempfile.mkdtemp(prefix='clone-take-'))
    kept, log = [], []
    for unit in line['units']:
        text, cands = plain(unit), []
        for _ in range(takes):
            y = np.concatenate([np.array(r.audio, dtype=np.float32).reshape(-1) for r in
                                model.generate(text=text, **extra)])
            y = kt.trim(y, sr, edge_db)
            tmp = work / 'unit.wav'
            sf.write(tmp, y, sr)
            heard = hear(str(tmp))
            cands.append({'y': y, 'heard': heard.strip(), 'err': errors(words(text), words(heard))})
        best = best_of(cands)
        kept.append(best['y'])
        log.append({'text': text, 'kept_errors': best['err'], 'all_errors': [c['err'] for c in cands],
                    'seconds': round(len(best['y']) / sr, 2), 'heard': best['heard']})
        print(json.dumps(log[-1], ensure_ascii=False), flush=True)
    return kept, log


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('line')
    ap.add_argument('engine')
    ap.add_argument('out')
    ap.add_argument('--takes', type=int)
    ap.add_argument('--ref')
    ap.add_argument('--ref-text', help='file with the exact words of --ref (default: --ref with .txt)')
    ap.add_argument('--settings-record')
    ap.add_argument('--film', help='the film the settings row is for (scope film); the person and account rows are read too')
    a = ap.parse_args(argv)
    try:
        cfg = kt.settings(a.settings_record, a.film)
        ENGINES.update({k: tuple(v) for k, v in (cfg.get('clone_engines') or {}).items()})
        if a.engine not in ENGINES:
            raise kt.Refusal(f'{a.engine} is not an engine here: use one of {", ".join(sorted(ENGINES))}, or add it to clone_engines')
        ref = a.ref or cfg.get('clone_reference')
        if not ref or not Path(ref).is_file():
            raise kt.Refusal(f'{ref or "no reference"} is not there: pass --ref, the recording the voice is cloned from, or set clone_reference')
        line = kt.read_line(a.line)
        repo, wants_words = ENGINES[a.engine]
        ref_text = Path(a.ref_text or Path(ref).with_suffix('.txt'))
        if wants_words and not ref_text.is_file():
            raise kt.Refusal(f'{a.engine} needs the exact words of the reference: pass --ref-text, a file of them ({ref_text} is not there)')
        extra = {'ref_audio': ref, **({'ref_text': ref_text.read_text().strip()} if wants_words else {})}
        hearer = kt.transcriber(cfg)
        try:
            from mlx_audio.tts.utils import load_model
        except ImportError:
            raise kt.Refusal('needs mlx-audio: python3 -m pip install -U mlx-audio numpy soundfile, on Apple silicon') from None
    except kt.Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    import soundfile as sf
    model = load_model(repo)
    sr = model.sample_rate

    def hear(path):
        return hearer.transcribe(path, path_or_hf_repo=cfg['whisper_model'], language='en',
                                 initial_prompt=line.get('hear_prompt'))['text']

    kept, log = say_units(line, model, extra, hear, sr,
                          a.takes or cfg['clone_takes'], cfg['edge_db'], Path(a.out).resolve().parent)
    sf.write(a.out, kt.join(kept, line, sr, cfg['edge_db']), sr, subtype='PCM_24')
    Path(a.out).with_suffix('.units.json').write_text(json.dumps(log, indent=1, ensure_ascii=False))
    print(json.dumps({'result': {'take': a.out, 'engine': a.engine, 'model': repo, 'sample_rate': sr,
                                 'units': str(Path(a.out).with_suffix('.units.json')),
                                 'word_errors': sum(u['kept_errors'] for u in log)}}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
