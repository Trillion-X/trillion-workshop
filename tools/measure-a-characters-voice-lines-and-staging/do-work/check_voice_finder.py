in data/voice/seeds.npz, over pitch-gate ratios and cosine thresholds. Window-level precision and recall.
usage: python3 -I eval_adaptive.py   (run from this checkout)"""
import os, sys, json, numpy as np, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hf_speaker as H
o = np.load(H.SEEDS, allow_pickle=True)
unit = lambda e: e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-9)
for ratio in (1.5, 1.6, 1.7):
    for tau in (0.4, 0.5, 0.6):
        line = []
        for ep in sorted(set(o['S'])):
            r = H.score(os.path.join(H.VOICE, ep), exclude=ep, tau=tau, ratio=ratio)
            d = np.load(os.path.join(H.VOICE, ep)); E = unit(d['emb'])
            hf = np.zeros(len(d['t']), bool)
            for a, b in r['turns']: hf |= (d['t'] + 0.75 >= a) & (d['t'] + 0.75 <= b)
            m = o['S'] == ep; idx = np.argmax(unit(o['X'][m]) @ E.T, axis=1); y = o['L'][m] == 'hf'; pr = hf[idx]
            tp = int((pr & y).sum()); fp = int((pr & ~y).sum()); fn = int((~pr & y).sum())
            line.append(f"{ep[:11]} P{tp / max(tp + fp, 1):.2f} R{tp / max(tp + fn, 1):.2f}")
        print(f'ratio {ratio} tau {tau}: ' + ' | '.join(line))
