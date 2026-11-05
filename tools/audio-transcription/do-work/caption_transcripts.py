"""Build transcripts/<id>.txt ([m:ss] ~30 s paragraphs, same shape as the other channel corpora) and index.tsv from raw/json3 + raw/meta + raw/flat-videos.jsonl. Run: python3 -I build_transcripts.py <channel-corpus-dir>"""
import json,sys,os,glob,csv,re
root=sys.argv[1]; raw=root+'/raw'
flat={}
for l in open(raw+'/flat-videos.jsonl'):
    d=json.loads(l); flat[d['id']]=d
os.makedirs(root+'/transcripts',exist_ok=True)
def stamp(s):
    s=int(s); h,m,sec=s//3600,(s%3600)//60,s%60
    return f'[{h}:{m:02d}:{sec:02d}]' if h else f'[{m}:{sec:02d}]'
rows=[]
for vid,fd in flat.items():
    mp=f'{raw}/meta/{vid}.meta.json'
    meta=json.load(open(mp)) if os.path.exists(mp) else {}
    files=sorted(glob.glob(f'{raw}/json3/{vid}.en*.json3'))
    # prefer manual 'en' over auto 'en-orig'
    pick=None
    for f in files:
        if f.endswith(f'{vid}.en.json3'): pick=f
    if not pick and files: pick=files[0]
    n=0; src=''
    if pick:
        ev=json.load(open(pick))['events']
        paras=[]; cur=None
        for e in ev:
            if 'segs' not in e: continue
            t=''.join(s.get('utf8','') for s in e['segs']).replace('\n',' ')
            if not t.strip(): continue
            st=e['tStartMs']/1000
            if cur is None or st-cur[0]>=30:
                cur=[st,[]]; paras.append(cur)
            cur[1].append(t.strip())
        src='yt-dlp, YouTube '+('captions' if pick.endswith(f'{vid}.en.json3') else 'auto-captions ('+os.path.basename(pick).split('.',1)[1].replace('.json3','')+')')
        with open(f'{root}/transcripts/{vid}.txt','w',encoding='utf8') as o:
