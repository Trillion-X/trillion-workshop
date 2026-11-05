import sys, json, glob, os
import numpy as np
from earshot import api
import librosa
D=os.path.dirname(os.path.abspath(__file__))
REFS=os.path.join(D,'..','refs','voice')
out={}
files=sorted(glob.glob(os.path.join(D,'v1','*.wav')))+sorted(glob.glob(os.path.join(REFS,'*.wav')))
for f in files:
    y,sr=librosa.load(f,sr=16000,mono=True)
    f0,vf,_=librosa.pyin(y,fmin=60,fmax=250,sr=sr,frame_length=1024)
    f0v=f0[~np.isnan(f0)]
    r=api.realness(f)
    m=api.match(f,'a calm deep British male documentary narrator speaking slowly')
    c=api.compare(f,refs=[REFS],k=3) if 'refs' not in f else None
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
json.dump(out,open(os.path.join(D,'scores.json'),'w'),indent=1)
