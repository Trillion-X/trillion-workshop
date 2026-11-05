"""Find when one character speaks in a show's recordings: speaker embeddings (pyannote wespeaker-voxceleb-resnet34-LM,
local cache) plus pitch. A character voiced by a cast member with the pitch raised is caught by pitch alone together with
every other high voice (actors, women, kids and music); the embedding tells the character's timbre from those.

One JSON request on standard input, {"result": ...} as the last line printed. step:
  embed   {audio, out}                    windows of 1.5 s every 0.5 s: embedding, median F0, loudness
  seed    {npz, label, ranges}            add the windows inside ranges ("a-b,a-b,...") to <data_folder>/voice/seeds.npz
  score   {npz, json?}                    the character's probability per window from the seed model, merged into turns
  batch   {audio_folder, reverse?}        embed and score every <data_folder>/catalog.tsv video not yet scored
  rescore {}                              score every <data_folder>/voice/<id>.emb.npz again with the current seeds
Every step but embed takes data_folder: the show's folder, holding catalog.tsv and voice/ (seeds.npz, <id>.emb.npz and
the <id>.turns.json the finder writes).

The settings (settings_record: the person's row of list:settings, read by tools/settings) name the character's label in
the seeds and its pitch gates; read-data/settings-keys.json says what each key means. HF_HUB_OFFLINE=1 keeps the model
local."""
import os, sys, json, subprocess, numpy as np
os.environ.setdefault('HF_HUB_OFFLINE', '1')
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
import shared  # noqa: E402
VOICE = SEEDS = LABEL = None   # <data_folder>/voice, its seeds.npz, and the settings' character_label
SR, WIN, HOP = 16000, 1.5, 0.5
EMBED_MIN_F0 = 200.0       # embed_min_pitch_hz: windows below this pitch, and below EMBED_RATIO x the median, are not embedded
EMBED_RATIO = 1.45         # embed_pitch_ratio
GATE_RATIO = 1.7           # gate_pitch_ratio: score()'s candidate windows are at least this x the recording's median pitch
GATE_MAX = 230.0           # gate_max_hz: the pitch gate never asks more than this
TAU = 0.4                  # voice_cosine_min
NEEDS = ['character_label', 'embed_min_pitch_hz', 'embed_pitch_ratio', 'gate_pitch_ratio', 'gate_max_hz', 'voice_cosine_min']

def load(path):
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768

_MODEL = {}

def embed(path, out):
    import torch, librosa
    from pyannote.audio import Model
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'   # about 1 ms per window on mps, 110 ms on the busy CPU
    if dev not in _MODEL:                       # one load per process: batch mode embeds many files
        _MODEL[dev] = Model.from_pretrained('pyannote/wespeaker-voxceleb-resnet34-LM').eval().to(dev)
    m = _MODEL[dev]
    y = load(path)
    w, h = int(WIN * SR), int(HOP * SR)
    starts = np.arange(0, max(len(y) - w, 1), h)
    rms = np.array([np.sqrt(np.mean(y[s:s + w] ** 2)) for s in starts], np.float32)
    keep = rms > 0.01                         # fixed floor: sponsor sketches are mixed about 8 dB under the narration
    y8 = y[::2]                                   # pitch at 8 kHz: about 8x less CPU on the loaded Mac, same 10 ms hop
    blk = 8000 * 600                              # 10-minute blocks: yin on a 3-hour Basement episode at once took 6.5 GB
    f0 = np.concatenate([librosa.yin(y8[i:i + blk + 512], fmin=70, fmax=600, sr=8000, frame_length=512, hop_length=80,
                                     center=False)[:blk // 80] for i in range(0, len(y8), blk) if len(y8[i:i + blk + 512]) > 1024])
    f0t = np.arange(len(f0)) * 80 / 8000
    embs = np.zeros((len(starts), 256), np.float32); pitch = np.zeros(len(starts), np.float32)
    idx = np.where(keep)[0]
    lo = np.searchsorted(f0t, starts / SR); hi = np.searchsorted(f0t, starts / SR + WIN)
    for j in idx:
        if hi[j] > lo[j]:
            pitch[j] = np.median(f0[lo[j]:hi[j]])
    # embed only windows that could be the character (score() asks at least as much pitch): far fewer windows
    base = float(np.median(pitch[idx][pitch[idx] > 0])) if (pitch[idx] > 0).any() else 120.0
    emb_idx = idx[pitch[idx] >= min(EMBED_MIN_F0, EMBED_RATIO * base)]
    with torch.no_grad():
        for i in range(0, len(emb_idx), 64):
            b = emb_idx[i:i + 64]
            x = torch.from_numpy(np.stack([y[starts[j]:starts[j] + w] for j in b]))[:, None, :].to(dev)
            embs[b] = m(x).cpu().numpy()
    np.savez_compressed(out, t=starts / SR, emb=embs, f0=pitch, rms=rms, keep=keep)
    print(out, len(starts), int(keep.sum()))
    return {'embeddings': out, 'windows': int(len(starts)), 'loud_windows': int(keep.sum()), 'embedded': int(len(emb_idx))}

def ranges(spec):
    return [tuple(map(float, r.split('-'))) for r in spec.split(',') if r]

def seed(npz, label, spec):
    d = np.load(npz); t = d['t']
    sel = np.zeros(len(t), bool)
    for a, b in ranges(spec):
        sel |= (t >= a) & (t + WIN <= b + 0.25)
    sel &= d['keep'] & (np.abs(d['emb']).sum(1) > 0)   # windows below the embed threshold have no embedding
    X, F, L, S = d['emb'][sel], d['f0'][sel], np.array([label] * sel.sum()), np.array([os.path.basename(npz)] * sel.sum())
    if os.path.exists(SEEDS):
        o = np.load(SEEDS, allow_pickle=True)
        X, F, L, S = np.vstack([o['X'], X]), np.concatenate([o['F'], F]), np.concatenate([o['L'], L]), np.concatenate([o['S'], S])
    np.savez_compressed(SEEDS, X=X, F=F, L=L, S=S)
    print(label, int(sel.sum()), 'windows; seeds now', dict(zip(*np.unique(L, return_counts=True))))
    return {'seeds': SEEDS, 'added': int(sel.sum()), 'counts': {str(k): int(v) for k, v in zip(*np.unique(L, return_counts=True))}}

def features(emb, f0):
    e = emb / (np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9)
    return np.hstack([e, (np.log(np.maximum(f0, 60)) - 5)[:, None] * 2])

_CLF = {}

def model(exclude=None):
    if exclude in _CLF:
        return _CLF[exclude]
    from sklearn.linear_model import LogisticRegression
    o = np.load(SEEDS, allow_pickle=True)
    m = np.ones(len(o['L']), bool) if exclude is None else (o['S'] != exclude)
    clf = LogisticRegression(max_iter=2000, C=1.0, class_weight='balanced')
    clf.fit(features(o['X'][m], o['F'][m]), (o['L'][m] == LABEL).astype(int))
    _CLF[exclude] = clf
    return clf

def unit(e):
    return e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-9)

def score(npz, out=None, exclude=None, tau=None, gate=None, ratio=None):
    """Adaptive per recording: the seed model finds the confident windows of the character (p > 0.7 among windows
    that pass the pitch gate); their mean embedding is this recording's voice of the character; a window is the
    character when it passes the gate and its cosine to that voice is > tau (the settings' voice_cosine_min unless
    given). do-work/check_voice_finder.py checks it on recordings it did not learn from."""
    tau = TAU if tau is None else tau
    d = np.load(npz); t, keep, f0 = d['t'], d['keep'], d['f0']
    E = unit(d['emb'])
    p = np.zeros(len(t))
    if keep.any():
        p[keep] = model(exclude).predict_proba(features(d['emb'][keep], f0[keep]))[:, 1]
    base = float(np.median(f0[keep & (f0 > 0)])) if (keep & (f0 > 0)).any() else 140.0
    if gate is None:                             # relative gate: one absolute pitch misses a character voiced lower later on
        gate = min(GATE_MAX, (ratio or GATE_RATIO) * base)
    cand = keep & (f0 >= gate) & (np.abs(d['emb']).sum(1) > 0)
    conf = cand & (p > 0.7)
    if conf.sum() < 5:
        conf = np.zeros(len(t), bool); conf[np.argsort(-(p * cand))[:10]] = True
    c = E[conf].mean(0); c /= (np.linalg.norm(c) + 1e-9)
    cos = E @ c
    said = cand & (cos > tau)
    turns, cur = [], None
    for i in range(len(t)):
        c0, c1 = t[i] + 0.5, t[i] + 1.0           # the middle 0.5 s of the window
        if said[i]:
            if cur and c0 - cur[1] <= 1.0: cur[1] = c1
            else:
                if cur: turns.append(cur)
                cur = [c0, c1]
    if cur: turns.append(cur)
    turns = [[round(float(a), 2), round(float(b), 2)] for a, b in turns if b - a >= 0.75]
    res = {'id': os.path.basename(npz).split('.')[0], 'duration_s': round(float(t[-1] + WIN), 1),
           'character_s': round(sum(b - a for a, b in turns), 1), 'turns': turns, 'tau': tau, 'gate_hz': round(gate, 1), 'episode_median_f0': round(base, 1),
           'confident_windows': int(conf.sum()), 'voice_cos_of_confident': round(float(cos[conf].mean()), 3),
           'p': [round(float(x), 3) for x in p], 'cos': [round(float(x), 3) for x in cos]}
    if out: json.dump(res, open(out, 'w'))
    return res

def configure(req, s):
    """Set the module's settings from the person's settings and the request's files."""
    global VOICE, SEEDS, LABEL, EMBED_MIN_F0, EMBED_RATIO, GATE_RATIO, GATE_MAX, TAU
    LABEL, EMBED_MIN_F0, EMBED_RATIO = s['character_label'], s['embed_min_pitch_hz'], s['embed_pitch_ratio']
    GATE_RATIO, GATE_MAX, TAU = s['gate_pitch_ratio'], s['gate_max_hz'], s['voice_cosine_min']
    if req.get('data_folder'):
        VOICE = os.path.join(req['data_folder'], 'voice')
        SEEDS = os.path.join(VOICE, 'seeds.npz')

if __name__ == '__main__':
    req, s = shared.request(NEEDS)
    configure(req, s)
    cmd = req.get('step')
    if cmd == 'embed': shared.answer(embed(*shared.needed(req, 'audio', 'out')))
    elif cmd == 'seed': shared.needed(req, 'data_folder'); shared.answer(seed(*shared.needed(req, 'npz', 'label', 'ranges')))
    elif cmd == 'batch':                         # batch: the settings' formats in order, the first format last to first with reverse
        import csv
        shared.needed(req, 'data_folder', 'audio_folder')
        if 'batch_format_order' not in s or 'audio_file' not in s:
            shared.fail('batch needs the settings batch_format_order and audio_file')
        rows = list(csv.DictReader(open(os.path.join(req['data_folder'], 'catalog.tsv')), delimiter='\t'))
        order = {f: i for i, f in enumerate(s['batch_format_order'])}
        todo = sorted(rows, key=lambda r: order.get(r['format'], 9))
        if req.get('reverse'):                   # a second process can work from the other end
            todo = [r for r in todo if r['format'] == s['batch_format_order'][0]][::-1]
        done, failed = [], []
        for r in todo:
            if r['format'] not in order: continue
            a = os.path.join(req['audio_folder'], s['audio_file'].replace('{id}', r['id'])); e = os.path.join(VOICE, r['id'] + '.emb.npz')
            h = os.path.join(VOICE, r['id'] + '.turns.json')
            if not os.path.exists(a) or os.path.exists(h) or os.path.exists(e + '.lock'): continue
            open(e + '.lock', 'w').close()
            try:
                if not os.path.exists(e): embed(a, e)
                x = score(e, h); print(x['id'], x['duration_s'], 'character_s', x['character_s'], 'turns', len(x['turns']), flush=True)
                done.append(x['id'])
            except Exception as ex:
                print('fail', r['id'], ex, flush=True)
                failed.append({'id': r['id'], 'error': str(ex)})
            finally:
                if os.path.exists(e + '.lock'): os.remove(e + '.lock')
        shared.answer({'scored': done, 'failed': failed})
    elif cmd == 'rescore':                       # rescore every .emb.npz with the current seeds (one model fit)
        import glob
        shared.needed(req, 'data_folder')
        n = 0
        for e in sorted(glob.glob(os.path.join(VOICE, '*.emb.npz'))):
            x = score(e, e.replace('.emb.npz', '.turns.json'))
            print(x['id'], x['character_s'], len(x['turns']), flush=True); n += 1
        shared.answer({'scored': n})
    elif cmd == 'score':
        shared.needed(req, 'npz', 'data_folder')
        r = score(req['npz'], req.get('json'))
        print(r['id'], r['duration_s'], 'character_s', r['character_s'], 'turns', len(r['turns']))
        shared.answer({'id': r['id'], 'duration_s': r['duration_s'], 'character_s': r['character_s'], 'turns': len(r['turns']), 'json': req.get('json')})
    else:
        shared.fail('step is one of embed, seed, score, batch, rescore')
