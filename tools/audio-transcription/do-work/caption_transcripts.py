#!/usr/bin/env python3
"""Build transcripts/<id>.txt ([m:ss] ~30 s paragraphs, the same shape as audio_transcription.py text) and index.tsv from the
YouTube json3 caption files a channel download left: raw/json3/<id>.en*.json3, raw/meta/<id>.meta.json and
raw/flat-videos.jsonl (one line per listed video) under the corpus folder.
Run: python3 -I caption_transcripts.py --corpus DIR --channel LABEL [--source-channel NAME]
The last line printed is {"result": {rows, with_captions, index}}."""
import argparse,json,sys,os,glob,csv,re
ap=argparse.ArgumentParser(description=__doc__)
ap.add_argument('--corpus',required=True,help='the channel corpus folder holding raw/')
ap.add_argument('--channel',required=True,help='the channel as each transcript names it on its Channel: line')
ap.add_argument('--source-channel',default='',help='the channel name kept in the index (default: --channel)')
args=ap.parse_args()
root=args.corpus; raw=root+'/raw'; channel=args.channel; source_channel=args.source_channel or args.channel
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
            o.write(f"# {meta.get('title') or fd['title']}\nhttps://www.youtube.com/watch?v={vid}\nChannel: {channel}\nCaptions: {src}\n\n")
            for st,ts in paras:
                o.write(stamp(st)+' '+re.sub(r'\s+',' ',' '.join(ts))+'\n')
        n=len(paras)
    rows.append([vid,meta.get('title') or fd['title'],meta.get('upload_date') or '',meta.get('view_count') if meta.get('view_count') is not None else (fd.get('view_count') or ''),meta.get('duration') or fd.get('duration') or '',meta.get('like_count') or '', 'yes' if n else 'no',source_channel,'videos','',n,os.path.basename(pick) if pick else ''])
with open(root+'/index.tsv','w',newline='',encoding='utf8') as o:
    w=csv.writer(o,delimiter='\t',lineterminator='\n')
    w.writerow(['id','title','upload_date','views','duration_s','likes','transcript_present','source_channel','kind','person_pick','transcript_lines','caption_file'])
    w.writerows(rows)
print(len(rows),'rows;',sum(1 for r in rows if r[6]=='yes'),'with captions')
print(json.dumps({'result':{'rows':len(rows),'with_captions':sum(1 for r in rows if r[6]=='yes'),'index':root+'/index.tsv'}}))
