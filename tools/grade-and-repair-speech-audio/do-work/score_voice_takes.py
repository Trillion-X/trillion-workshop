"""Score voice takes against the voice wanted and against recordings of it, to choose a voice and a speed.

  score_voice_takes.py <takes folder> <references folder> "<the voice wanted, in words>" <out.json>

Every <takes>/*.wav and every reference recording gets its pitch (median and spread, pyin), earshot's realness, how well it
matches the voice wanted (a description in the person's own words) and, for a take, how typical it is of the references
(earshot compare, three nearest). A take with <name>.words.json beside it (a list of words, or an object whose `words` is
one) also gets words per second. Writes <out.json> ({file name: scores}) and last {"result": {"out", "takes"}}. Needs numpy,
librosa and earshot (the local listening package: api.realness, api.match, api.compare).
"""
import sys, json, glob, os
import numpy as np
from earshot import api
import librosa
D, REFS, WANTED, OUT = sys.argv[1:5]
out={}
files=sorted(glob.glob(os.path.join(D,'*.wav')))+sorted(glob.glob(os.path.join(REFS,'*.wav')))
for f in files:
    y,sr=librosa.load(f,sr=16000,mono=True)
    f0,vf,_=librosa.pyin(y,fmin=60,fmax=250,sr=sr,frame_length=1024)
    f0v=f0[~np.isnan(f0)]
    r=api.realness(f)
    m=api.match(f,WANTED)
    c=api.compare(f,refs=[REFS],k=3) if not f.startswith(os.path.join(REFS,'')) else None
    rec={'f0_median_hz':round(float(np.median(f0v)),1),'f0_iqr_hz':round(float(np.percentile(f0v,75)-np.percentile(f0v,25)),1),
         'realness':{k:r[k] for k in r if k in ('p_real','verdict')},
         'match_z':m.get('z'),'match_verdict':m.get('verdict'),
         'compare':({k:c[k] for k in c if k in ('typicality','typicality_verdict','summary')} if c else None)}
    wj=f[:-4]+'.words.json'
    if os.path.exists(wj):
        w=json.load(open(wj)); words=w.get('words',w) if isinstance(w,dict) else w
        dur=len(y)/sr; rec['wps']=round(len(words)/dur,2); rec['dur_s']=round(dur,2)
    out[os.path.basename(f)]=rec
    print(os.path.basename(f),json.dumps(rec)[:400],flush=True)
json.dump(out,open(OUT,'w'),indent=1)
print(json.dumps({'result':{'out':OUT,'takes':len(out)}}))
