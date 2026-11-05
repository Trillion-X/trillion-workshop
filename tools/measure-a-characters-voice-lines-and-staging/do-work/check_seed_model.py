"""Leave-one-recording-out check of the seed model of do-work/find_voice.py: train on the other recordings' seeds,
score the held-out recording's labelled windows. Prints window precision and recall for the character at the turn
rule's threshold (p > 0.5) and pitch gate (the settings' embed_min_pitch_hz).
One JSON request on standard input: {data_folder, settings_record?, settings?}; the seeds are
<data_folder>/voice/seeds.npz. {"result": ...} is the last line printed."""
import os, sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
import find_voice as H
import shared  # noqa: E402
req, s = shared.request(H.NEEDS)
shared.needed(req, 'data_folder')
H.configure(req, s)
out = []
o = np.load(H.SEEDS, allow_pickle=True)
for ep in sorted(set(o['S'])):
    m = o['S'] == ep
    clf = H.model(exclude=ep)
    p = clf.predict_proba(H.features(o['X'][m], o['F'][m]))[:, 1]
    pred = (p > 0.5) & (o['F'][m] >= H.EMBED_MIN_F0)
    y = o['L'][m] == H.LABEL
    tp = int((pred & y).sum()); fp = int((pred & ~y).sum()); fn = int((~pred & y).sum())
    out.append({'recording': str(ep), 'tp': tp, 'fp': fp, 'fn': fn})
    print(f'{ep}: character windows {int(y.sum())}, other {int((~y).sum())}; precision {tp / max(tp + fp, 1):.2f} recall {tp / max(tp + fn, 1):.2f} (tp {tp} fp {fp} fn {fn})')
shared.answer(out)
