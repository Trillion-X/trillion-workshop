#!/usr/bin/env python3
"""Resolve a declared intake and review into existing packaging rows, without mutation."""
import argparse, json
from pathlib import Path
import blake3

def main():
    p=argparse.ArgumentParser(); p.add_argument('--root',type=Path,required=True); p.add_argument('--intake',type=Path,required=True); p.add_argument('--channel-catalog',type=Path,required=True); p.add_argument('--review',type=Path,required=True); p.add_argument('--source-key',required=True); p.add_argument('--ledger',type=Path,required=True); p.add_argument('--before-ledger',type=Path,required=True); p.add_argument('--output',type=Path,required=True); p.add_argument('--update-existing',action='store_true'); a=p.parse_args()
    root=a.root.resolve(); intake=json.loads(a.intake.read_text()); cat=json.loads(a.channel_catalog.read_text()); review=json.loads(a.review.read_text())
    target={x['video_id']:x for x in review['items']}; admitted={x['video_id']:x for x in intake['videos']}; entries={x['video_id']:x for x in cat['entries']}; rows={}
    for line in a.ledger.read_text().splitlines():
        if not line.strip(): continue
        r=json.loads(line)
        if r['video_id'] in target: rows[r['video_id']]=r
    ids=sorted(target); assert set(ids)<=set(rows)
    resolved={}
    for vid in ids:
        r=rows[vid]; item=target[vid]
        assert r['source_key']==a.source_key and r['source_channel_id']==cat['channel_id']
        assert r['metadata_title']==entries[vid]['title']==admitted[vid]['title']
        metapath=(a.intake.resolve().parent/admitted[vid]['metadata_path']).resolve(); assert metapath.is_file() and str(metapath.relative_to(root))==r['metadata_source_path']
        metabytes=metapath.read_bytes(); meta_identity=r['metadata_source_identity']; assert meta_identity['value']==blake3.blake3(metabytes).hexdigest() and meta_identity['bytes']==len(metabytes)
        metadata=json.loads(metabytes); assert r.get('description')==metadata.get('description')
        assert r['thumbnail_words']['value']==item['thumbnail_words']
        assert r['thumbnail_analysis']['title_thumbnail_role_relation']==item['title_thumbnail_relation']
        image=Path(r['thumbnail_image_path']); assert image.is_file()
        assert blake3.blake3(image.read_bytes()).hexdigest()==r['thumbnail_blake3']['value']
        assert image.stat().st_size==r['thumbnail_blake3']['bytes']==item['image_bytes']
        for ref in r['caption_sources']: assert (root/ref).is_file()
        for kind in ('opening_hook_evidence','internal_hook_evidence'):
            for e in r[kind]:
                path=root/e['source_path']; assert path.is_file() and e.get('caption_text_copied') is False and 'text' not in e
                raw=path.read_bytes(); identity=e['source_file_identity']; assert identity['value']==blake3.blake3(raw).hexdigest() and identity['bytes']==len(raw)
                events=json.loads(raw).get('events',[]); idx=e['source_event_index']; assert 0<=idx<len(events)
                event=events[idx]; assert abs(event.get('tStartMs',0)/1000-e['start_s'])<=0.001
                assert abs((event.get('tStartMs',0)+event.get('dDurationMs',0))/1000-e['end_s'])<=0.001
        for ref in r['admission_provenance'].values(): assert (root/ref).is_file()
        resolved[vid]={'source_key':r['source_key'],'channel_id':r['source_channel_id'],'title':r['metadata_title'],'metadata_source_path':r['metadata_source_path'],'metadata_source_identity':r['metadata_source_identity'],'description_present':bool(r.get('description')),'image_blake3':r['thumbnail_blake3']['value'],'image_bytes':r['thumbnail_blake3']['bytes'],'thumbnail_words':r['thumbnail_words']['value'],'title_relation':r['thumbnail_analysis']['title_thumbnail_role_relation'],'opening_hook_interpretation':r.get('opening_hook_interpretation'),'opening_event_refs':r['opening_hook_evidence'],'internal_hook_interpretation':r.get('internal_hook_interpretation'),'internal_event_refs':r['internal_hook_evidence'],'caption_source_count':len(r['caption_sources']),'caption_text_copied':False,'resolved_reference_count':len(r['caption_sources'])+len(r['opening_hook_evidence'])+len(r['internal_hook_evidence'])+len(r['admission_provenance'])+1}
    before=[json.loads(l) for l in a.before_ledger.read_text().splitlines() if l.strip()]
    after=[json.loads(l) for l in a.ledger.read_text().splitlines() if l.strip()]
    after_by_id={r['video_id']:r for r in after}
    if a.update_existing:
        preserved=all(after_by_id.get(r['video_id'])==r for r in before if r['video_id'] not in ids)
        assert preserved and len(after)==len(before)
        assert all({r['video_id']:r for r in before}[vid].get('thumbnail_words',{}).get('status')=='unreviewed' and after_by_id[vid].get('thumbnail_words',{}).get('status')=='directly reviewed' for vid in ids)
    else:
        preserved=all(after_by_id.get(r['video_id'])==r for r in before)
        assert preserved and len(after)==len(before)+len(ids)
    x={'schema':'youtube-packaging-intake-consumer-readback@1','update_existing':a.update_existing,'source_key':a.source_key,'intake_manifest':str(a.intake.relative_to(root)),'channel_catalog':str(a.channel_catalog.relative_to(root)),'video_ids':ids,'ledger_row_count':sum(1 for l in a.ledger.open() if l.strip()),'resolved_rows':resolved,'rows_before':len(before),'rows_after':len(after),'all_old_non_target_rows_preserved':preserved,'evidence_references_resolved':True}
    a.output.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n'); print(json.dumps({'rows':len(ids),'evidence_references_resolved':True,'output':str(a.output)}))
if __name__=='__main__': main()
