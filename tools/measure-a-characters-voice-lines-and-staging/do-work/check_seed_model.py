usage: python3 -I eval_loo.py"""
import os, sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hf_speaker as H
o = np.load(H.SEEDS, allow_pickle=True)
for ep in sorted(set(o['S'])):
    m = o['S'] == ep
    clf = H.model(exclude=ep)
    p = clf.predict_proba(H.features(o['X'][m], o['F'][m]))[:, 1]
    pred = (p > 0.5) & (o['F'][m] >= 200)
    y = o['L'][m] == 'hf'
    tp = int((pred & y).sum()); fp = int((pred & ~y).sum()); fn = int((~pred & y).sum())
