"""Audit of quotes taken from whisper transcripts: locate the quote's words in raw/whisper/<id>.json (word timings) and report the exact start second; check it lies inside the cited paragraph window. Usage: audit_whisper_quotes.py <corpus dir>"""
import csv,json,re,sys,os
D=sys.argv[1]
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
    if not hits: print('NOT FOUND',vid,r['quote'][:60]); bad+=1; continue
    for j in hits:
        w0=W[flat[j][0]]; w1=W[flat[j+len(q)-1][0]]
        ok=secs(r['stamp'])<=w0['s']<secs(r['stamp'])+45
        print(vid,r['stamp'],'word times %.2f-%.2f'%(w0['s'],w1['e']),'in window' if ok else 'OUTSIDE window',f'(hit {hits.index(j)+1} of {len(hits)})',r['quote'][:50])
        if not ok: bad+=1
print(n,'whisper quotes;',bad,'problems')
