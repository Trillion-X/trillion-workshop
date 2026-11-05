#!/usr/bin/env python3
"""Audit of quotes taken from whisper transcripts: locate the quote's words in raw/whisper/<id>.json (word timings) and report the exact start second; check it lies inside the cited paragraph window.
The corpus folder holds index.tsv (id, caption_source), quote-check.tsv (video, stamp, quote) and raw/whisper/<id>.json
({words: [{w, s, e}]}). Usage: find_whisper_quotes.py --corpus DIR [--window-seconds 45]; the last line printed is
{"result": {quotes, problems, hits}}."""
import argparse,csv,json,re,sys,os
ap=argparse.ArgumentParser(description=__doc__)
ap.add_argument('--corpus',required=True)
ap.add_argument('--window-seconds',type=float,default=45.0,help='how long after its stamp a cited paragraph runs (default 45)')
args=ap.parse_args(); D=args.corpus; found=[]
idx={r['id']:r for r in csv.DictReader(open(D+'/index.tsv'),delimiter='\t')}
def secs(st): 
    p=[int(x) for x in st.split(':')]; return p[0]*60+p[1] if len(p)==2 else p[0]*3600+p[1]*60+p[2]
norm=lambda t: re.findall(r"[a-z0-9]+",t.lower())
seen=set(); bad=0; n=0
for r in csv.DictReader(open(D+'/quote-check.tsv'),delimiter='\t'):
    vid=r['video']
    if vid not in idx or not idx[vid]['caption_source'].startswith('whisper'): continue
    k=(vid,r['stamp'],r['quote'])
    if k in seen: continue
    seen.add(k); n+=1
    d=json.load(open(f'{D}/raw/whisper/{vid}.json')); W=d['words']; ws=[norm(w['w']) for w in W]
    flat=[(i,t) for i,x in enumerate(ws) for t in x]; toks=[t for _,t in flat]; q=norm(r['quote'])
    hits=[j for j in range(len(toks)-len(q)+1) if toks[j:j+len(q)]==q]
    if not hits: print('NOT FOUND',vid,r['quote'][:60]); bad+=1; found.append({'video':vid,'stamp':r['stamp'],'quote':r['quote'],'found':False}); continue
    for j in hits:
        w0=W[flat[j][0]]; w1=W[flat[j+len(q)-1][0]]
        ok=secs(r['stamp'])<=w0['s']<secs(r['stamp'])+args.window_seconds
        print(vid,r['stamp'],'word times %.2f-%.2f'%(w0['s'],w1['e']),'in window' if ok else 'OUTSIDE window',f'(hit {hits.index(j)+1} of {len(hits)})',r['quote'][:50])
        if not ok: bad+=1
        found.append({'video':vid,'stamp':r['stamp'],'quote':r['quote'],'found':True,'start':w0['s'],'end':w1['e'],'in_window':ok,'hit':hits.index(j)+1,'of':len(hits)})
print(n,'whisper quotes;',bad,'problems')
print(json.dumps({'result':{'quotes':n,'problems':bad,'hits':found}},ensure_ascii=False))
