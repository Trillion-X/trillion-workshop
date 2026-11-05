"""Leave-one-recording-out check of the adaptive finder (do-work/find_voice.py score) on every hand-labelled recording
in <data_folder>/voice/seeds.npz, over pitch-gate ratios and cosine thresholds. Window-level precision and recall.
One JSON request on standard input: {data_folder, ratios?, cosines?, settings_record?, settings?} (ratios default to
1.5, 1.6, 1.7 and cosines to 0.4, 0.5, 0.6). {"result": ...} is the last line printed."""
import os, sys, json, numpy as np, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
import find_voice as H
import shared  # noqa: E402
req, s = shared.request(H.NEEDS)
shared.needed(req, 'data_folder')
H.configure(req, s)
out = []
o = np.load(H.SEEDS, allow_pickle=True)
unit = lambda e: e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-9)
for ratio in req.get('ratios') or (1.5, 1.6, 1.7):
    for tau in req.get('cosines') or (0.4, 0.5, 0.6):
        line = []
        for ep in sorted(set(o['S'])):
            r = H.score(os.path.join(H.VOICE, ep), exclude=ep, tau=tau, ratio=ratio)
            d = np.load(os.path.join(H.VOICE, ep)); E = unit(d['emb'])
            said = np.zeros(len(d['t']), bool)
            for a, b in r['turns']: said |= (d['t'] + 0.75 >= a) & (d['t'] + 0.75 <= b)
            m = o['S'] == ep; idx = np.argmax(unit(o['X'][m]) @ E.T, axis=1); y = o['L'][m] == H.LABEL; pr = said[idx]
            tp = int((pr & y).sum()); fp = int((pr & ~y).sum()); fn = int((~pr & y).sum())
            out.append({'ratio': ratio, 'cosine': tau, 'recording': str(ep), 'tp': tp, 'fp': fp, 'fn': fn})
            line.append(f"{ep[:11]} P{tp / max(tp + fp, 1):.2f} R{tp / max(tp + fn, 1):.2f}")
        print(f'ratio {ratio} tau {tau}: ' + ' | '.join(line))
shared.answer(out)
