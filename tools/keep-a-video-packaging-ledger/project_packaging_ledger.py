#!/usr/bin/env python3
"""Project one source_key from VIDEO-PACKAGING JSONL into the generic packaging HTML/spec DATA.

The record set is an inert application/json block consumed by the existing html_json_records
reader. Caption text is not copied; only exact source-file identity, event-index range, and
observed time envelope are recorded.
"""
import argparse, html, json
from pathlib import Path
import blake3
from copy import deepcopy

_CAPTION_TEXT_FIELDS = {
    'text', 'quote', 'verbatim_source_excerpt', 'normalized_text',
    'raw_caption_payload_lines', 'caption_text', 'opening_caption_text',
}

def project_hook_references(references):
    """Keep hook provenance locators while leaving caption excerpts in their source DATA."""
    def without_excerpt(value):
        if isinstance(value, dict):
            # Preserve evidence containers; only excerpt-bearing child keys are removed.
            return {key: without_excerpt(item) for key, item in value.items()
                    if key not in _CAPTION_TEXT_FIELDS}
        if isinstance(value, list):
            return [without_excerpt(item) for item in value]
        return value

    projected = []
    for reference in references:
        item = without_excerpt(deepcopy(reference))
        if isinstance(item, dict):
            item['caption_text_copied'] = False
        projected.append(item)
    return projected

def b3(path): return {'algorithm':'blake3','value':blake3.blake3(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size}

def normalize_thumbnail_identity(value, image_path, root):
    """Accept current identity objects and verify legacy bare BLAKE3 strings."""
    if isinstance(value, dict):
        return value
    if value is None:
        return {}
    if not isinstance(value, str):
        raise TypeError('thumbnail_blake3 must be an identity object or legacy digest string')
    path = Path(image_path) if image_path else None
    if path is None:
        raise ValueError('legacy thumbnail digest has no image path to verify')
    if not path.is_absolute():
        path = root / path
    if not path.is_file():
        raise FileNotFoundError(f'legacy thumbnail image is missing: {path}')
    identity = b3(path)
    if identity['value'] != value:
        raise ValueError(f'legacy thumbnail digest does not match retained image: {path}')
    return identity

def effective_thumbnail_analysis(row):
    """Read current analysis fields, falling back to the original nested thumbnail words shape."""
    current = row.get('thumbnail_analysis')
    current = current if isinstance(current, dict) else {}
    legacy = row.get('thumbnail_words')
    legacy = legacy if isinstance(legacy, dict) else {}
    return {
        'composition': current.get('composition', legacy.get('composition')),
        'title_thumbnail_role_relation': current.get('title_thumbnail_role_relation', legacy.get('title_thumbnail_role_relation')),
        'within_batch_pattern_sample': current.get('within_batch_pattern_sample', legacy.get('within_batch_pattern_sample')),
        'pattern_scope': current.get('pattern_scope', legacy.get('pattern_scope')),
        'source_review': current.get('source_review', legacy.get('review_source')),
    }

def thumbnail_word_parts(item):
    """Normalize reviewed text to a string while keeping role/confidence separate."""
    if isinstance(item, dict):
        text = item.get('text', item.get('thumbnail_text'))
        provenance = {k: item[k] for k in ('role', 'glyph_confidence', 'confidence') if item.get(k) is not None}
    else:
        text = item
        provenance = {}
    if not isinstance(text, str):
        raise TypeError('thumbnail word must contain string text')
    return text, provenance

def resolve_thumbnail_review_source(row, analysis, root):
    """Resolve current workspace-relative review paths or legacy intake-root-relative paths."""
    source_review = analysis.get('source_review')
    if not source_review:
        return None
    source_path = Path(source_review)
    if source_path.is_absolute():
        if not source_path.is_file():
            raise FileNotFoundError(f'thumbnail review source is missing: {source_path}')
        return str(source_path)
    if (root / source_path).is_file():
        return str(source_path)
    metadata_path = row.get('metadata_source_path')
    if isinstance(metadata_path, str) and '/intake/' in metadata_path:
        source_root = metadata_path.split('/intake/', 1)[0]
        candidate = Path(source_root) / source_path
        if (root / candidate).is_file():
            return str(candidate)
    raise FileNotFoundError(f'thumbnail review source cannot be resolved from row metadata: {source_review}')

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--ledger',type=Path,required=True);p.add_argument('--source-key',required=True);p.add_argument('--output-html',type=Path,required=True);p.add_argument('--output-spec',type=Path,required=True);p.add_argument('--previous-html',type=Path,help='Existing packaging DATA source to retain unchanged authored records and identities from');p.add_argument('--replace-video-id',action='append',default=[],help='Replace this unit from the ledger while retaining every other prior source record');a=p.parse_args()
    root=a.root.resolve(); rows=[json.loads(l) for l in a.ledger.read_text().splitlines() if l.strip()]; rows=[r for r in rows if r['source_key']==a.source_key]
    if not rows: raise SystemExit('source_key has no packaging rows')
    ids=[r['video_id'] for r in rows]
    if len(set(ids))!=len(ids): raise SystemExit('duplicate video_id within source_key')
    replacement_ids=set(a.replace_video_id)
    if a.replace_video_id:
        if not a.previous_html: raise SystemExit('--replace-video-id requires --previous-html')
        if len(replacement_ids)!=len(a.replace_video_id): raise SystemExit('--replace-video-id values must be unique members of this source_key')
        missing_replacements=replacement_ids-set(ids)
        if missing_replacements: raise SystemExit(f'--replace-video-id values must be members of this source_key: {sorted(missing_replacements)}')
    prior_caption_ids={}; prior_records=[]
    if a.previous_html:
        prior_doc=a.previous_html.read_text()
        match=__import__('re').search(r'<script[^>]*id=["\']packaging["\'][^>]*>(.*?)</script>',prior_doc,__import__('re').S)
        if not match: raise SystemExit(f'previous packaging source has no packaging JSON block: {a.previous_html}')
        prior_records=json.loads(match.group(1))
        for record in prior_records:
            provenance=record.get('source_provenance') or {}
            if record.get('region')=='transcript-reference' and provenance.get('path'):
                prior_caption_ids[(record.get('unit'),provenance['path'])]=record['id']
    records=[]
    for order,r in enumerate(rows,1):
        # A replacement only needs fresh reads for the selected target rows.
        # Keep `order` from the complete source-key sequence above so selected
        # child record IDs and ordering remain stable relative to full projection.
        if replacement_ids and r['video_id'] not in replacement_ids:
            continue
        caption_refs=[]
        for ref in r.get('caption_sources',[]):
            path=(root/ref).resolve()
            if not path.is_file(): raise SystemExit(f'missing caption source: {ref}')
            identity=b3(path); event_count=None; event_range=None; time_range=None
            if path.suffix in ('.json3','.json'):
                try:
                    data=json.loads(path.read_text()); events=data.get('events',[])
                    event_count=len(events)
                    if events:
                        event_range=[0,len(events)-1]
                        starts=[e.get('tStartMs',0)/1000 for e in events]
                        ends=[(e.get('tStartMs',0)+e.get('dDurationMs',0))/1000 for e in events]
                        time_range=[min(starts),max(ends)]
                except (json.JSONDecodeError,UnicodeDecodeError): pass
            ref_rec={'path':ref,'source_format':'youtube-json3' if path.suffix=='.json3' else path.suffix.lstrip('.'),'video_id':r['video_id'],'source_file_identity':{'bytes':identity['bytes'],'blake3':identity['value']},'event_count':event_count,'event_index_range':event_range,'time_range_s':time_range}
            caption_refs.append(ref_rec)
            suffix=f"{order:03d}" if len(caption_refs)==1 else f"{order:03d}-{len(caption_refs):03d}"
            record_id=prior_caption_ids.get((f"video-{r['video_id']}",ref),f"{r['video_id']}.caption-source-ref-{suffix}")
            records.append({'id':record_id,'unit':f"video-{r['video_id']}",'region':'transcript-reference','record_order':500000+order*100+len(caption_refs),'fields':{},'source_provenance':{'reference_type':'canonical_caption_source','path':ref,'video_id':r['video_id'],'source_format':ref_rec['source_format'],'source_file_identity':ref_rec['source_file_identity'],'event_count':event_count,'caption_text_copied':False,'range_semantics':'outer envelope of captured event indices/times; original file retains individual event timing and text','event_index_range':event_range,'time_range_s':time_range}})
        metadata_path=r.get('metadata_source_path')
        meta_identity=b3(root/metadata_path) if metadata_path and (root/metadata_path).is_file() else None
        image_path=r.get('thumbnail_image_path')
        thumb=normalize_thumbnail_identity(r.get('thumbnail_blake3'), image_path, root)
        provenance={'video_id':r['video_id'],'source_key':a.source_key,'source_channel_id':r.get('source_channel_id'),'url':r['url'],'admission_provenance':r.get('admission_provenance'),'metadata_source_reference':{'path':metadata_path,'identity':meta_identity},'thumbnail_reference':{'status':'retained image directly reviewed','path':image_path,'bytes':thumb.get('bytes'),'blake3':thumb.get('value')},'caption_source_references':caption_refs,'caption_text_copied':False}
        records.append({'id':f"video-{r['video_id']}",'is_unit':True,'order':order,'fields':{'order':order},'source_provenance':provenance})
        meta_data=json.loads((root/metadata_path).read_text()) if metadata_path and meta_identity else {}
        title=r.get('metadata_title') or r.get('inventory_title')
        records.append({'id':f"{r['video_id']}.title",'unit':f"video-{r['video_id']}",'region':'title','record_order':order,'fields':{'title':title,'metadata_title':title},'source_provenance':{'path':metadata_path,'source_file_identity':meta_identity,'video_id':r['video_id'],'value_source':'admitted metadata title'}})
        if isinstance(meta_data.get('description'), str):
            records.append({'id':f"{r['video_id']}.description",'unit':f"video-{r['video_id']}",'region':'description','record_order':order+1,'fields':{'description':meta_data['description']},'source_provenance':{'path':metadata_path,'value_source':'retained per-video extractor metadata description','video_id':r['video_id'],'metadata_file_identity':meta_identity}})
        for n,item in enumerate(r.get('thumbnail_words',{}).get('value') or [],1):
            word, word_provenance=thumbnail_word_parts(item)
            records.append({'id':f"{r['video_id']}.thumbnail-text-{n}",'unit':f"video-{r['video_id']}",'region':'thumbnail','record_order':order+n,'fields':{'thumbnail_text':word},'source_provenance':{'path':image_path,'bytes':thumb.get('bytes'),'blake3':thumb.get('value'),'value_source':'direct original-image inspection','review_batch':r.get('thumbnail_analysis',{}).get('source_review'),'video_id':r['video_id'],**word_provenance}})
        # Older rows store selected caption excerpts with inline text. Migrate them to
        # event/time locators from the canonical caption file; never copy that text.
        for n, sample in enumerate(r.get('opening_hook_evidence') or [],1):
            if not (isinstance(sample,dict) and 'text' in sample and sample.get('source_path')):
                continue
            source_path=Path(sample['source_path'])
            if not source_path.is_absolute(): source_path=root/source_path
            raw=json.loads(source_path.read_text()); events=raw.get('events',[])
            matches=[]
            for idx,event in enumerate(events):
                start=event.get('tStartMs',0)/1000
                end=(event.get('tStartMs',0)+event.get('dDurationMs',0))/1000
                if abs(start-float(sample['start_s']))<=0.001 and abs(end-float(sample['end_s']))<=0.001:
                    matches.append(idx)
            if len(matches)!=1: raise ValueError(f"opening span must resolve to one exact caption event: {r['video_id']} #{n}")
            idx=matches[0]; ident=b3(source_path)
            if sample.get('source_blake3') and sample['source_blake3']!=ident['value']:
                raise ValueError(f"opening span source identity mismatch: {r['video_id']}")
            records.append({'id':f"{r['video_id']}.caption.opening.{n:03d}",'unit':f"video-{r['video_id']}",'region':'captions','record_order':order+70+n,'fields':{},'source_provenance':{'path':str(source_path),'source_file_identity':{'bytes':ident['bytes'],'blake3':ident['value']},'video_id':r['video_id'],'evidence_type':'caption event excerpt locator','interpretation_status':'caption-evidenced opening candidate; no speech/intent/effect claim','source_event_index':idx,'t0':sample['start_s'],'t1':sample['end_s'],'caption_text_copied':False}})
        analysis=effective_thumbnail_analysis(r)
        analysis['source_review']=resolve_thumbnail_review_source(r,analysis,root)
        records.append({'id':f"{r['video_id']}.thumbnail-analysis",'unit':f"video-{r['video_id']}",'region':'thumbnail-analysis','record_order':order+50,'fields':{'composition':analysis.get('composition'),'title_thumbnail_role_relation':analysis.get('title_thumbnail_role_relation')},'source_provenance':{'path':analysis.get('source_review'),'image_path':image_path,'image_identity':thumb,'video_id':r['video_id'],'caption_audio_verification':'not independently verified'}})
        for hook_kind,field_prefix in (('opening','opening_hook'),('internal_hook','internal_hook')):
            hook_refs=r.get(f'{field_prefix}_evidence') or []
            interpretation=r.get(f'{field_prefix}_interpretation')
            if not interpretation or not hook_refs: continue
            projected_hook_refs=project_hook_references(hook_refs)
            evidence_fields={'hook_source_evidence':json.dumps(projected_hook_refs,ensure_ascii=False,separators=(',',':')),'excerpt_metadata':f"{len(projected_hook_refs)} caption evidence locators; excerpt text remains in source DATA and caption files; see the structured caption source references"}
            provenance={'reference_type':'caption-evidenced candidate; excerpt text remains in source DATA and caption file','video_id':r['video_id'],'source_key':a.source_key,'caption_source_references':projected_hook_refs,'caption_text_copied':False,'speech_independently_verified':False,'internal_sample_exhaustive':False if hook_kind=='internal_hook' else None}
            records.append({'id':f"{r['video_id']}.{hook_kind}-evidence",'unit':f"video-{r['video_id']}",'region':'speech-text','record_order':order+58+(1 if hook_kind=='internal_hook' else 0),'fields':evidence_fields,'source_provenance':provenance})
            analysis_fields={'hook_analysis':interpretation,'hook_sequence_roles':'captioned opening sequence' if hook_kind=='opening' else 'bounded internal passage; sampled, not exhaustive','hook_specific_failure_or_boundary':r.get(f'{field_prefix}_qualification'),'hook_title_thumbnail_relation':analysis.get('title_thumbnail_role_relation')}
            if hook_kind=='opening':
                analysis_fields['opening_hook_analysis']=interpretation
                analysis_fields['hook_pattern_candidate']=analysis.get('within_batch_pattern_sample')
            else:
                analysis_fields['internal_hook_analysis']=interpretation
            records.append({'id':f"{r['video_id']}.{hook_kind}-analysis",'unit':f"video-{r['video_id']}",'region':'hook-analysis','record_order':order+60+(1 if hook_kind=='internal_hook' else 0),'fields':analysis_fields,'source_provenance':provenance})
    if a.replace_video_id:
        replace_units={f"video-{video_id}" for video_id in a.replace_video_id}
        def belongs_to_replaced_unit(record):
            return record.get('unit') in replace_units or record.get('id') in replace_units
        prior_target_ids={record['id'] for record in prior_records if belongs_to_replaced_unit(record)}
        projected_target_ids={record['id'] for record in records if belongs_to_replaced_unit(record)}
        # Keep authored and legacy target records this projector does not own.
        # New canonical hook records can coexist with their earlier source analyses.
        records.extend(deepcopy(record) for record in prior_records
                       if belongs_to_replaced_unit(record) and record['id'] not in projected_target_ids)
        projected_target_ids={record['id'] for record in records if belongs_to_replaced_unit(record)}
        missing_prior=prior_target_ids-projected_target_ids
        if missing_prior: raise SystemExit(f'projected replacement would drop prior target record IDs: {sorted(missing_prior)}')
        # A source replacement may refresh provenance, but must not silently
        # reorder existing records from the stable source DATA sequence.
        prior_units={record['id']:record for record in prior_records if record.get('is_unit') and belongs_to_replaced_unit(record)}
        for record in records:
            previous=prior_units.get(record['id'])
            if previous is None or not record.get('is_unit'):
                continue
            record['order']=previous.get('order',record.get('order'))
            record['fields']=previous.get('fields',record.get('fields',{}))
        projected_target_records=[record for record in records if belongs_to_replaced_unit(record)]
        projected_by_id={record['id']:record for record in projected_target_records}
        if len(projected_by_id)!=len(projected_target_records): raise SystemExit('duplicate projected target record IDs')
        merged=[]
        for previous in prior_records:
            if not belongs_to_replaced_unit(previous):
                merged.append(previous)
                continue
            replacement=projected_by_id[previous['id']]
            merged.append(replacement)
        # Upsert existing target records in place. Append only new record IDs,
        # so filtering the result to old IDs yields the complete prior sequence.
        records=merged+[record for record in projected_target_records if record['id'] not in prior_target_ids]
    current_ids={record['id'] for record in records}
    if len({record['id'] for record in records})!=len(records): raise SystemExit('duplicate record IDs after preserving prior packaging membership')
    doc='<!doctype html>\n<meta charset="utf-8">\n<script type="application/json" id="packaging">'+json.dumps(records,ensure_ascii=False,separators=(',',':'))+'</script>\n'
    generated_spec={'schema':'word-template-spec@1','piece':{'id':f'youtube-source:{a.source_key}','medium':'video-corpus','kind':'reference','source_key':a.source_key},'sources':{'html_json_records':{'path':str(a.output_html),'script_id':'packaging','required':True}}}
    spec=generated_spec
    if a.replace_video_id and a.output_spec.is_file():
        try:
            previous_spec=json.loads(a.output_spec.read_text(encoding='utf-8'))
        except (OSError,json.JSONDecodeError) as exc:
            raise SystemExit(f'cannot preserve existing editable spec {a.output_spec}: {exc}')
        if not isinstance(previous_spec,dict):
            raise SystemExit(f'existing editable spec must be a JSON object: {a.output_spec}')
        previous_piece=previous_spec.get('piece') or {}
        previous_sources=previous_spec.get('sources') or {}
        if not isinstance(previous_piece,dict) or not isinstance(previous_sources,dict):
            raise SystemExit(f'existing spec piece and sources must be JSON objects: {a.output_spec}')
        # The spec is also the editor's judgment DATA: keep lines, slots, KEEP
        # exceptions and custom fields while refreshing only generated identity.
        spec={**previous_spec,'schema':generated_spec['schema'],
              'piece':{**previous_piece,**generated_spec['piece']}}
        merged_sources=dict(previous_sources)
        for name,source in generated_spec['sources'].items():
            previous_source=merged_sources.get(name)
            if isinstance(previous_source,dict) and isinstance(source,dict):
                merged_sources[name]={**previous_source,**source}
            else:
                merged_sources[name]=source
        spec['sources']=merged_sources
    a.output_html.parent.mkdir(parents=True,exist_ok=True);a.output_spec.parent.mkdir(parents=True,exist_ok=True)
    a.output_html.write_text(doc)
    a.output_spec.write_text(json.dumps(spec,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'source_key':a.source_key,'videos':len(rows),'records':len(records),'output_html':str(a.output_html),'output_spec':str(a.output_spec)}))
if __name__=='__main__': main()
