#!/usr/bin/env python3
"""Append/reconcile explicitly admitted channel rows in VIDEO-PACKAGING JSONL.

The intake/catalog/review tuple is the membership authority. Caption files remain exact
references; text is not duplicated. A failure between coverage and ledger replacement is
recoverable: retry reconciles the same source summary and exact rows, while mismatches fail.
"""
import argparse, json, math
from pathlib import Path

def blake3(path):
    try: import blake3 as mod
    except ImportError as e: raise SystemExit('Python blake3 module required') from e
    h=mod.blake3()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()

def atomic_write(path,text):
    path.parent.mkdir(parents=True,exist_ok=True); tmp=path.with_name(path.name+'.tmp'); tmp.write_text(text); tmp.replace(path)

def atomic_write_bytes(path,raw):
    path.parent.mkdir(parents=True,exist_ok=True); tmp=path.with_name(path.name+'.tmp'); tmp.write_bytes(raw); tmp.replace(path)

def file_identity(path):
    path=Path(path); return {'algorithm':'blake3','value':blake3(path),'bytes':path.stat().st_size}

def _json_pointer_value(value,pointer):
    """Resolve an RFC 6901 pointer without evaluating source content."""
    if pointer=='': return value
    if not isinstance(pointer,str) or not pointer.startswith('/'): raise ValueError('JSON pointer must be empty or begin with /')
    current=value
    for token in pointer[1:].split('/'):
        token=token.replace('~1','/').replace('~0','~')
        if isinstance(current,list):
            if not token.isdigit(): raise ValueError('JSON pointer array index is invalid')
            current=current[int(token)]
        elif isinstance(current,dict): current=current[token]
        else: raise ValueError('JSON pointer traverses a scalar')
    return current

def _walk_json_objects(value):
    if isinstance(value,dict):
        yield value
        for child in value.values(): yield from _walk_json_objects(child)
    elif isinstance(value,list):
        for child in value: yield from _walk_json_objects(child)

def _observation_contains_locator(observation,locator):
    """Require the linked structured observation to contain this caption event."""
    event_index=locator['source_event_index']; start=float(locator['start_s']); end=float(locator['end_s']); excerpt=locator['excerpt']
    for item in _walk_json_objects(observation):
        indexes=[]
        for key in ('source_event_index','event_index'):
            if isinstance(item.get(key),int) and not isinstance(item.get(key),bool): indexes.append(item[key])
        for key in ('source_event_indexes','event_indexes'):
            values=item.get(key)
            if isinstance(values,list): indexes.extend(v for v in values if isinstance(v,int) and not isinstance(v,bool))
        if event_index not in indexes: continue
        clocks_match=True
        for key in ('start_s','start','t0'):
            if key in item:
                try: clocks_match=clocks_match and abs(float(item[key])-start)<=.001
                except (TypeError,ValueError): clocks_match=False
        for key in ('end_s','end','t1'):
            if key in item:
                try: clocks_match=clocks_match and abs(float(item[key])-end)<=.001
                except (TypeError,ValueError): clocks_match=False
        texts=[item[key] for key in ('excerpt','text','caption_text','normalized_text') if isinstance(item.get(key),str)]
        if texts and excerpt not in texts: clocks_match=False
        if clocks_match: return True
    return False

def direct_review_batch(root,ledger,batch_path,readback,prospective_ledger=None,dry_run=False,expected_ledger_blake3=None):
    """Apply a directly inspected thumbnail batch to existing rows without rewriting unrelated JSONL lines."""
    import blake3 as blake3_module
    root=Path(root).resolve(); ledger=Path(ledger); batch_path=Path(batch_path); readback=Path(readback)
    if not expected_ledger_blake3: raise SystemExit('--expected-ledger-blake3 is required for direct-review updates')
    original=ledger.read_bytes(); before={'algorithm':'blake3','value':blake3(ledger),'bytes':len(original)}
    if before['value']!=expected_ledger_blake3: raise SystemExit('canonical ledger BLAKE3 differs from the required preimage')
    batch=json.loads(batch_path.read_text())
    if batch.get('schema')!='thumbnail-review-batch-readback@1': raise SystemExit('unsupported direct-review batch schema')
    items=batch.get('selected_records') or []
    ids=[item.get('video_id') for item in items]
    if not ids or len(ids)!=len(set(ids)): raise SystemExit('direct-review batch must contain distinct video IDs')
    if not all(item.get('note_path') and item.get('note_identity') for item in items): raise SystemExit('direct-review batch is missing note identities')

    lines=original.splitlines(keepends=True); rows=[]; row_line_indexes={}; reviewed_ids=set(); reviewed_hashes=set()
    for line_index,line in enumerate(lines):
        if not line.strip(): continue
        row=json.loads(line)
        if row['video_id'] in row_line_indexes: raise SystemExit(f"duplicate ledger video ID: {row['video_id']}")
        row_line_indexes[row['video_id']]=line_index; rows.append(row)
        if (row.get('thumbnail_words') or {}).get('status')=='directly reviewed':
            reviewed_ids.add(row['video_id'])
            thumb=row.get('thumbnail_blake3')
            reviewed_hashes.add(thumb.get('value') if isinstance(thumb,dict) else thumb)
    if not set(ids)<=set(row_line_indexes): raise SystemExit(f'missing current ledger targets: {sorted(set(ids)-set(row_line_indexes))}')
    row_by_id={row['video_id']:row for row in rows}
    patches={}; target_receipts=[]

    def require_identity(ref,path,label):
        actual=file_identity(path)
        if ref.get('algorithm','blake3')!='blake3' or ref.get('value')!=actual['value'] or ref.get('bytes')!=actual['bytes']:
            raise SystemExit(f'{label}: BLAKE3 or byte-count mismatch')
        return actual

    for item in items:
        vid=item['video_id']; row=row_by_id[vid]; note_path=(root/item['note_path']).resolve(); note=json.loads(note_path.read_text())
        require_identity(item['note_identity'],note_path,f'{vid}: review note')
        if note.get('schema')!='thumbnail-source-review-note@1' or note.get('video_id')!=vid or note.get('source_key')!=item.get('source_key'):
            raise SystemExit(f'{vid}: review note identity or scope mismatch')
        expected_line=note.get('ledger_source',{}).get('line')
        actual_line=row_line_indexes[vid]+1
        if expected_line!=actual_line or note.get('ledger_source',{}).get('thumbnail_status_at_selection')!='unreviewed':
            raise SystemExit(f'{vid}: ledger line or pre-review status differs from the note')
        if row.get('source_key')!=item['source_key'] or row.get('inventory_title')!=note['title'].get('inventory_title'):
            raise SystemExit(f'{vid}: ledger source-key or inventory-title join mismatch')
        status=(row.get('thumbnail_words') or {}).get('status')
        if status not in ('unreviewed','directly reviewed'): raise SystemExit(f'{vid}: thumbnail row is not eligible for direct-review update')
        if status=='unreviewed' and (vid in reviewed_ids or ((row.get('thumbnail_blake3') or {}).get('value') if isinstance(row.get('thumbnail_blake3'),dict) else row.get('thumbnail_blake3')) in reviewed_hashes):
            raise SystemExit(f'{vid}: selected ID or image hash already appears in the direct-review set')
        if any(other_id!=vid and other_hash==((row.get('thumbnail_blake3') or {}).get('value') if isinstance(row.get('thumbnail_blake3'),dict) else row.get('thumbnail_blake3')) for other_id,other_hash in ((r['video_id'],(r.get('thumbnail_blake3') or {}).get('value') if isinstance(r.get('thumbnail_blake3'),dict) else r.get('thumbnail_blake3')) for r in rows)):
            raise SystemExit(f'{vid}: retained thumbnail hash is shared with another ledger video')

        metadata_ref=note['title']['source_identity']; metadata_path=root/metadata_ref['path']
        metadata_identity=require_identity(metadata_ref,metadata_path,f'{vid}: metadata source')
        metadata=json.loads(metadata_path.read_text())
        if metadata.get('id')!=vid or metadata.get('title')!=note['title'].get('exact_metadata_value') or metadata.get('description')!=note['description'].get('exact_metadata_value'):
            raise SystemExit(f'{vid}: metadata ID/title/description differs from the review note')
        if metadata_ref['path'] not in (row.get('caption_sources') or []): raise SystemExit(f'{vid}: metadata file is not pinned by the ledger caption sources')
        if item.get('metadata_identity',{}).get('value')!=metadata_identity['value'] or item.get('metadata_identity',{}).get('bytes')!=metadata_identity['bytes']:
            raise SystemExit(f'{vid}: batch metadata identity differs from the note')

        thumb_ref=note['thumbnail']['source_identity']; image_path=root/thumb_ref['path']; image_identity=require_identity(thumb_ref,image_path,f'{vid}: retained thumbnail')
        old_thumb=row.get('thumbnail_blake3') or {}; old_value=old_thumb.get('value') if isinstance(old_thumb,dict) else old_thumb
        if row.get('thumbnail_image_path')!=thumb_ref['path'] or old_value!=image_identity['value']:
            raise SystemExit(f'{vid}: note thumbnail does not join to the retained ledger image')
        if item.get('thumbnail_identity',{}).get('value')!=image_identity['value'] or item.get('thumbnail_identity',{}).get('bytes')!=image_identity['bytes']:
            raise SystemExit(f'{vid}: batch thumbnail identity differs from the note')

        caption_ref=note['opening_caption']['source_identity']; caption_path=root/caption_ref['path']
        caption_identity=require_identity(caption_ref,caption_path,f'{vid}: opening caption source')
        if caption_ref['path'] not in (row.get('caption_sources') or []): raise SystemExit(f'{vid}: opening-caption file is not pinned by the ledger')
        events=json.loads(caption_path.read_text()).get('events',[]); locators=[]
        for cue in note['opening_caption'].get('cues') or []:
            index=cue.get('event_index')
            if not isinstance(index,int) or not 0<=index<len(events): raise SystemExit(f'{vid}: invalid exact opening-caption event index')
            event=events[index]; start=event.get('tStartMs',0)/1000; end=(event.get('tStartMs',0)+event.get('dDurationMs',0))/1000
            text=''.join(seg.get('utf8','') for seg in event.get('segs',[]))
            if abs(start-float(cue.get('start_s',-999)))>.001 or abs(end-float(cue.get('end_s',-999)))>.001 or text!=cue.get('text'):
                raise SystemExit(f'{vid}: exact opening-caption locator no longer matches its source event')
            locators.append({'source_path':caption_ref['path'],'source_file_identity':caption_identity,'source_event_index':index,'start_s':cue['start_s'],'end_s':cue['end_s'],'caption_text_copied':False})
        if not locators: raise SystemExit(f'{vid}: direct-review note contains no exact caption locators')

        visible=note['thumbnail'].get('visible_text') or []
        if not visible or not note['thumbnail'].get('composition') or not note['thumbnail'].get('title_relation'):
            raise SystemExit(f'{vid}: direct-review note lacks visible text, composition, or title relation')
        date=metadata.get('upload_date')
        if not isinstance(date,str) or len(date)!=8 or not date.isdigit(): raise SystemExit(f'{vid}: retained metadata upload_date is missing or malformed')
        date_iso=f'{date[:4]}-{date[4:6]}-{date[6:]}'
        title=metadata['title']; inv_title=row.get('inventory_title')
        field_updates={
            'title':'retained info.json title matches inventory title' if title==inv_title else 'retained info.json title retained separately from the differently formatted inventory title',
            'description':'retained info.json description; uploader-supplied and not independently verified' if metadata.get('description') else 'retained info.json description is empty',
            'metadata_date':f'retained info.json upload_date {date_iso}; does not establish image/caption creation date',
            'thumbnail_image':'retained original image; BLAKE3 checked; directly reviewed',
            'thumbnail_words':'directly reviewed from the retained original; visible text and roles retained',
        }
        patch={
            'metadata_title':title,'metadata_source_path':metadata_ref['path'],'metadata_source_identity':metadata_identity,
            'description':metadata.get('description') if isinstance(metadata.get('description'),str) else '',
            'thumbnail_image_path':thumb_ref['path'],'thumbnail_blake3':image_identity,
            'thumbnail_words':{'status':'directly reviewed','value':visible},
            'thumbnail_analysis':{'visible_text':visible,'composition':note['thumbnail']['composition'],'title_thumbnail_role_relation':note['thumbnail']['title_relation'],'source_review':str(note_path.relative_to(root)),'visual_qualification':note['thumbnail'].get('qualification')},
            'thumbnail_review_provenance':{'image_path':thumb_ref['path'],'image_identity':image_identity,'title_source_path':metadata_ref['path'],'title_source_identity':metadata_identity,'review_note':str(note_path.relative_to(root)),'caption_audio_verification':'not independently verified'},
        }
        current_fields=row.get('field_status') or {}; merged_fields={**current_fields,**field_updates}
        if status=='directly reviewed':
            if any(row.get(key)!=value for key,value in patch.items()) or any(current_fields.get(k)!=v for k,v in field_updates.items()):
                raise SystemExit(f'{vid}: previously applied direct review does not exactly match this note and source data')
            updated=row
        else:
            updated={**row,**patch,'field_status':merged_fields}
        patches[vid]=updated
        target_receipts.append({'video_id':vid,'source_key':row['source_key'],'note_path':str(note_path.relative_to(root)),'thumbnail_identity':image_identity,'metadata_identity':metadata_identity,'thumbnail_text':[word.get('text',word.get('thumbnail_text')) if isinstance(word,dict) else word for word in visible],'packet_caption_cues_verified':len(locators),'existing_caption_and_hook_evidence_preserved':True,'caption_text_copied_from_review_note':False,'status':'already-applied' if status=='directly reviewed' else 'updated'})

    output_lines=[]; non_target_exact=True
    for index,line in enumerate(lines):
        if not line.strip(): output_lines.append(line); continue
        row=json.loads(line); replacement=patches.get(row['video_id'])
        if replacement is None: output_lines.append(line); continue
        ending=b'\r\n' if line.endswith(b'\r\n') else b'\n' if line.endswith(b'\n') else b''
        output_lines.append(json.dumps(replacement,ensure_ascii=False,separators=(',',':')).encode('utf-8')+ending)
    output=b''.join(output_lines); after_identity={'algorithm':'blake3','value':blake3_module.blake3(output).hexdigest(),'bytes':len(output)}
    if len(output_lines)!=len(lines): raise SystemExit('direct-review patch changed JSONL line count')
    # Prove that every unselected source line remains byte-for-byte identical.
    for index,(old_line,new_line) in enumerate(zip(lines,output_lines)):
        old_obj=json.loads(old_line) if old_line.strip() else None
        if old_obj and old_obj.get('video_id') not in patches and old_line!=new_line: non_target_exact=False
    if not non_target_exact: raise SystemExit('non-target JSONL bytes changed')
    if dry_run:
        if prospective_ledger is None: raise SystemExit('--prospective-ledger is required with --dry-run')
        atomic_write_bytes(prospective_ledger,output)
        final_identity=file_identity(prospective_ledger)
        status='prospective'
    else:
        atomic_write_bytes(ledger,output)
        final_identity=file_identity(ledger)
        if final_identity['value']!=after_identity['value'] or final_identity['bytes']!=after_identity['bytes']:
            raise SystemExit('canonical ledger post-write identity differs from the validated direct-review patch')
        status='applied'
    result={'schema':'youtube-packaging-direct-review-ledger-readback@1','status':status,'batch_path':str(batch_path),'batch_identity':file_identity(batch_path),'ledger_path':str(ledger),'ledger_before':before,'ledger_after':final_identity,'row_count_before':len(rows),'row_count_after':len(rows),'row_order_preserved':True,'non_target_jsonl_lines_byte_exact':non_target_exact,'target_count':len(items),'targets':target_receipts,'caption_text_copied_from_review_notes':False}
    readback.parent.mkdir(parents=True,exist_ok=True); readback.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':status,'target_count':len(items),'row_count':len(rows),'non_target_jsonl_lines_byte_exact':non_target_exact,'ledger_after':final_identity}))

def identity_only_update(root,ledger,contract_path,readback,preimage_path,expected_ledger_blake3):
    """Pin an existing metadata locator's current identity without changing review evidence."""
    import base64
    import blake3 as blake3_module
    root=Path(root).resolve(); ledger=Path(ledger).resolve(); contract_path=Path(contract_path).resolve()
    readback=Path(readback).resolve(); preimage_path=Path(preimage_path).resolve()
    if not expected_ledger_blake3: raise SystemExit('--expected-ledger-blake3 is required for identity-only updates')
    for path,label in ((ledger,'ledger'),(contract_path,'contract'),(readback,'readback'),(preimage_path,'preimage')):
        try: path.relative_to(root)
        except ValueError: raise SystemExit(f'{label} path escapes --root')
    if readback.exists(): raise SystemExit('identity-only readback destination already exists; refusing to overwrite an applied receipt')
    original=ledger.read_bytes()
    before={'algorithm':'blake3','value':blake3_module.blake3(original).hexdigest(),'bytes':len(original)}
    if before['value']!=expected_ledger_blake3: raise SystemExit('canonical ledger BLAKE3 differs from the required preimage')
    contract=json.loads(contract_path.read_text())
    if contract.get('schema')!='youtube-packaging-identity-only-update@1': raise SystemExit('unsupported identity-only update contract schema')
    source_key=contract.get('source_key'); locator=contract.get('metadata_source_path'); expected=contract.get('metadata_identity')
    if not isinstance(source_key,str) or not source_key or not isinstance(locator,str) or not locator or not isinstance(expected,dict):
        raise SystemExit('identity-only contract requires source_key, metadata_source_path, and metadata_identity')
    if Path(locator).is_absolute(): raise SystemExit('metadata source locator must be root-relative')
    source_path=(root/locator).resolve()
    try: source_path.relative_to(root)
    except ValueError: raise SystemExit('metadata source path escapes --root')
    if not source_path.is_file(): raise SystemExit('metadata source path is not an existing file')
    actual=file_identity(source_path)
    if expected.get('algorithm')!='blake3' or expected.get('value')!=actual['value'] or expected.get('bytes')!=actual['bytes']:
        raise SystemExit('metadata source BLAKE3 or byte-count differs from contract')
    lines=original.splitlines(keepends=True); matches=[]; all_rows=[]
    for index,line in enumerate(lines):
        if not line.strip(): continue
        row=json.loads(line); all_rows.append(row)
        if row.get('source_key')==source_key and row.get('metadata_source_path')==locator:
            matches.append((index,line,row))
    if len(matches)!=1: raise SystemExit(f'identity-only source-key/locator selection must match exactly one ledger row; found {len(matches)}')
    index,line,row=matches[0]
    if row.get('metadata_source_identity') not in (None,actual):
        raise SystemExit('existing metadata_source_identity differs; no identity-version contract is supported')
    already=row.get('metadata_source_identity')==actual
    preimage_reused=False; prior_identity=before
    if already:
        after=before
        inverse={'algorithm':'blake3','value':before['value'],'bytes':before['bytes']}
        selected_preimage=line
        status='already-applied'
        if preimage_path.exists():
            try:
                saved=json.loads(preimage_path.read_text())
                saved_line=base64.b64decode(saved['selected_line_utf8_base64'],validate=True)
                saved_before=saved['ledger_before']
            except (OSError,ValueError,KeyError,TypeError,json.JSONDecodeError) as exc:
                raise SystemExit(f'existing identity-only preimage is unreadable; refusing to replace it: {exc}')
            if saved.get('schema')!='youtube-packaging-identity-only-preimage@1' or saved.get('source_key')!=source_key or saved.get('metadata_source_path')!=locator or saved.get('line_number')!=index+1:
                raise SystemExit('existing identity-only preimage belongs to a different selection; refusing to replace it')
            inverse_candidate=b''.join(saved_line if i==index else other for i,other in enumerate(lines))
            inverse={'algorithm':'blake3','value':blake3_module.blake3(inverse_candidate).hexdigest(),'bytes':len(inverse_candidate)}
            if inverse!=saved_before:
                raise SystemExit('existing identity-only preimage does not reconstruct its recorded whole-ledger preimage; refusing to replace it')
            prior_identity=saved_before; preimage_reused=True
        else:
            preimage_path.parent.mkdir(parents=True,exist_ok=True)
            preimage_path.write_text(json.dumps({'schema':'youtube-packaging-identity-only-preimage@1','ledger_before':before,'line_number':index+1,'selected_line_utf8_base64':base64.b64encode(selected_preimage).decode('ascii'),'source_key':source_key,'metadata_source_path':locator,'metadata_source_identity_before':row.get('metadata_source_identity')},indent=2)+'\n')
    else:
        selected_preimage=line
        row_after=dict(row); row_after['metadata_source_identity']=actual
        if any(row_after.get(key)!=value for key,value in row.items() if key!='metadata_source_identity'):
            raise SystemExit('identity-only update changed a non-target row field')
        ending=b'\r\n' if line.endswith(b'\r\n') else b'\n' if line.endswith(b'\n') else b''
        replacement=json.dumps(row_after,ensure_ascii=False,separators=(',',':')).encode('utf-8')+ending
        output=b''.join(replacement if i==index else other for i,other in enumerate(lines))
        if len(output.splitlines(keepends=True))!=len(lines): raise SystemExit('identity-only update changed ledger line count')
        for i,(old,new) in enumerate(zip(lines,output.splitlines(keepends=True))):
            if i!=index and old!=new: raise SystemExit('identity-only update changed a non-target JSONL line')
        if ledger.read_bytes()!=original: raise SystemExit('canonical ledger changed during identity-only validation')
        if preimage_path.exists(): raise SystemExit('identity-only preimage destination already exists; refusing to overwrite it')
        preimage_path.parent.mkdir(parents=True,exist_ok=True)
        preimage_path.write_text(json.dumps({'schema':'youtube-packaging-identity-only-preimage@1','ledger_before':before,'line_number':index+1,'selected_line_utf8_base64':base64.b64encode(selected_preimage).decode('ascii'),'source_key':source_key,'metadata_source_path':locator,'metadata_source_identity_before':row.get('metadata_source_identity')},indent=2)+'\n')
        atomic_write_bytes(ledger,output)
        written=ledger.read_bytes(); after={'algorithm':'blake3','value':blake3_module.blake3(written).hexdigest(),'bytes':len(written)}
        if written!=output: raise SystemExit('canonical ledger post-write bytes differ from validated output')
        inverse_output=b''.join(selected_preimage if i==index else other for i,other in enumerate(written.splitlines(keepends=True)))
        inverse={'algorithm':'blake3','value':blake3_module.blake3(inverse_output).hexdigest(),'bytes':len(inverse_output)}
        if inverse!=before: raise SystemExit('exact inverse reconstruction does not match whole-ledger preimage identity')
        status='updated'
    result={'schema':'youtube-packaging-identity-only-readback@1','status':status,'contract_path':str(contract_path.relative_to(root)),'contract_identity':file_identity(contract_path),'ledger_path':str(ledger.relative_to(root)),'ledger_before':before,'ledger_after':after,'selected_row_count':1,'selected_line_number':index+1,'source_key':source_key,'metadata_source_path':locator,'metadata_source_identity':actual,'only_metadata_source_identity_changed':True,'non_target_jsonl_lines_byte_exact':True,'row_count_before':len(all_rows),'row_count_after':len(all_rows),'all_other_target_fields_equal':True,'idempotent_bytes_preserved':already,'preimage_path':str(preimage_path.relative_to(root)),'preimage_reused_without_overwrite':preimage_reused,'whole_ledger_prior_identity_retained':prior_identity,'exact_inverse_reconstruction_identity':inverse,'exact_inverse_verified':inverse==prior_identity}
    readback.parent.mkdir(parents=True,exist_ok=True); readback.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':status,'source_key':source_key,'metadata_source_path':locator,'ledger_after':after,'preimage_reused_without_overwrite':preimage_reused,'exact_inverse_verified':inverse==prior_identity}))

def hook_enrichment_update(root,ledger,contract_path,readback,preimage_path,expected_ledger_blake3,prospective_ledger=None,apply=False):
    """Add pinned caption-event evidence and interpretation to existing packaging rows."""
    import base64
    import blake3 as blake3_module
    root=Path(root).resolve(); ledger=Path(ledger).resolve(); contract_path=Path(contract_path).resolve()
    readback=Path(readback).resolve(); preimage_path=Path(preimage_path).resolve()
    if not expected_ledger_blake3: raise SystemExit('--expected-ledger-blake3 is required for hook enrichment')
    if apply and prospective_ledger: raise SystemExit('--apply and --prospective-ledger cannot be combined')
    if not apply and not prospective_ledger: raise SystemExit('hook enrichment requires --prospective-ledger; canonical apply requires explicit --apply')
    paths=[(ledger,'ledger'),(contract_path,'contract'),(readback,'readback'),(preimage_path,'preimage')]
    if prospective_ledger: paths.append((Path(prospective_ledger).resolve(),'prospective ledger'))
    if len({str(path) for path,_ in paths})!=len(paths): raise SystemExit('hook enrichment input/output paths must be distinct')
    for path,label in paths:
        try: path.relative_to(root)
        except ValueError: raise SystemExit(f'{label} path escapes --root')
    if readback.exists(): raise SystemExit('hook enrichment readback destination already exists; refusing to overwrite')
    if prospective_ledger and Path(prospective_ledger).resolve().exists(): raise SystemExit('prospective ledger destination already exists; refusing to overwrite')
    original=ledger.read_bytes(); before={'algorithm':'blake3','value':blake3_module.blake3(original).hexdigest(),'bytes':len(original)}
    if before['value']!=expected_ledger_blake3: raise SystemExit('canonical ledger BLAKE3 differs from the required preimage')
    contract=json.loads(contract_path.read_text())
    if contract.get('schema')!='youtube-packaging-hook-enrichment@1': raise SystemExit('unsupported hook-enrichment contract schema')
    source_key=contract.get('source_key'); updates=contract.get('updates')
    if not isinstance(source_key,str) or not source_key or not isinstance(updates,list) or not updates: raise SystemExit('hook contract requires source_key and nonempty updates')
    lines=original.splitlines(keepends=True); rows=[]; indexes={}; by_id={}
    for i,line in enumerate(lines):
        if not line.strip(): continue
        row=json.loads(line); vid=row.get('video_id')
        if not isinstance(vid,str) or vid in indexes: raise SystemExit(f'duplicate or missing ledger video ID: {vid}')
        rows.append(row); indexes[vid]=i; by_id[vid]=row
    vids=[u.get('video_id') if isinstance(u,dict) else None for u in updates]
    if any(not isinstance(v,str) or not v for v in vids) or len(vids)!=len(set(vids)): raise SystemExit('hook updates must have distinct video IDs')
    replacements={}; selected_preimages=[]; receipts=[]; global_locators=set()
    def identity(path):
        raw=path.read_bytes(); return {'algorithm':'blake3','value':blake3_module.blake3(raw).hexdigest(),'bytes':len(raw)}
    for update in updates:
        vid=update['video_id']; row=by_id.get(vid)
        if row is None or row.get('source_key')!=source_key: raise SystemExit(f'{vid}: target is not an existing row under source_key')
        patched=dict(row); changed=[]; prior_snapshot={}
        hooks=[kind for kind in ('opening_hook','internal_hook') if kind in update]
        if not hooks: raise SystemExit(f'{vid}: update must include opening_hook and/or internal_hook')
        field_status_current=row.get('field_status') or {}
        if not isinstance(field_status_current,dict): raise SystemExit(f'{vid}: field_status must be an object')
        field_status=dict(field_status_current)
        for kind in hooks:
            spec=update[kind]
            if not isinstance(spec,dict): raise SystemExit(f'{vid}: {kind} must be an object')
            if spec.get('merge_strategy')!='append_distinct': raise SystemExit(f'{vid}: {kind} requires explicit merge_strategy append_distinct')
            evidence_key=f'{kind}_evidence'; status_key=f'{kind}_status'; interpretation_key=f'{kind}_interpretation'; qualification_key=f'{kind}_qualification'
            expected_prior=spec.get('expected_prior_fields')
            current={k:row.get(k) for k in (evidence_key,status_key,interpretation_key,qualification_key)}
            if not isinstance(expected_prior,dict) or expected_prior!=current: raise SystemExit(f'{vid}: {kind} prior fields do not match the exact pinned snapshot')
            prior_status=current.get(status_key)
            if isinstance(prior_status,str) and prior_status.casefold() in ('no hook','no-hook','none','absent','not present'):
                raise SystemExit(f'{vid}: an existing no-hook conclusion cannot be reinterpreted by caption-only evidence')
            prior_interpretation=current.get(interpretation_key)
            if prior_interpretation not in (None,'',spec.get('interpretation')):
                raise SystemExit(f'{vid}: existing {kind} interpretation is populated and differs; additive evidence cannot replace it')
            if not isinstance(spec.get('status'),str) or not spec['status'] or not isinstance(spec.get('interpretation'),str) or not spec['interpretation'].strip(): raise SystemExit(f'{vid}: {kind} requires explicit status and interpretation')
            if spec['status'].casefold() in ('no hook','no-hook','none','absent','not present'): raise SystemExit(f'{vid}: caption-only evidence cannot establish a no-hook conclusion')
            qualification=spec.get('qualification')
            if not isinstance(qualification,str) or not qualification.strip(): raise SystemExit(f'{vid}: {kind} requires an explicit nonempty qualification')
            locators=spec.get('caption_locators')
            if not isinstance(locators,list) or not locators: raise SystemExit(f'{vid}: {kind} requires caption locators')
            old_refs=row.get(evidence_key) or []
            if not isinstance(old_refs,list): raise SystemExit(f'{vid}: existing {kind} evidence is not a list')
            seen=set()
            for ref in old_refs:
                if not isinstance(ref,dict): raise SystemExit(f'{vid}: existing {kind} evidence ref is malformed')
                marker=(ref.get('source_path'),ref.get('source_event_index'))
                seen.add(marker)
            additions=[]
            for locator in locators:
                if not isinstance(locator,dict): raise SystemExit(f'{vid}: malformed caption locator')
                rel=locator.get('source_path')
                if not isinstance(rel,str) or not rel: raise SystemExit(f'{vid}: caption source path must be a retained nonempty locator')
                path_obj=Path(rel); source=(path_obj if path_obj.is_absolute() else root/path_obj).resolve()
                try: source.relative_to(root)
                except ValueError: raise SystemExit(f'{vid}: caption source path escapes --root')
                caption_sources=row.get('caption_sources')
                if not isinstance(caption_sources,list) or any(not isinstance(path,str) or not path for path in caption_sources) or len(caption_sources)!=len(set(caption_sources)):
                    raise SystemExit(f'{vid}: retained caption_sources must be a unique list of nonempty paths')
                if not source.is_file() or rel not in caption_sources: raise SystemExit(f'{vid}: caption source is not a retained source for this ledger row')
                actual=identity(source); expected=locator.get('source_file_identity')
                if expected!={'algorithm':'blake3','value':actual['value'],'bytes':actual['bytes']}: raise SystemExit(f'{vid}: caption source identity differs from locator pin')
                declared_identities=row.get('caption_source_identities')
                if declared_identities is not None:
                    if not isinstance(declared_identities,list): raise SystemExit(f'{vid}: retained caption source identities must be a list')
                    declared=[entry.get('identity') for entry in declared_identities if isinstance(entry,dict) and entry.get('path')==rel]
                    if len(declared)!=1 or declared[0]!=actual: raise SystemExit(f'{vid}: retained caption source identity list conflicts with the pinned source file')
                raw=json.loads(source.read_text()); events=raw.get('events')
                idx=locator.get('source_event_index')
                if not isinstance(events,list) or not isinstance(idx,int) or isinstance(idx,bool) or idx<0 or idx>=len(events): raise SystemExit(f'{vid}: invalid caption event index')
                event=events[idx]
                start=event.get('tStartMs',0)/1000; end=(event.get('tStartMs',0)+event.get('dDurationMs',0))/1000
                excerpt=''.join(seg.get('utf8','') for seg in event.get('segs',[]))
                if isinstance(locator.get('start_s'),bool) or isinstance(locator.get('end_s'),bool): raise SystemExit(f'{vid}: caption locator clocks must be numeric seconds')
                try: start_pin=float(locator.get('start_s')); end_pin=float(locator.get('end_s'))
                except (TypeError,ValueError): raise SystemExit(f'{vid}: caption locator requires numeric start_s and end_s')
                if not math.isfinite(start_pin) or not math.isfinite(end_pin): raise SystemExit(f'{vid}: caption locator clocks must be finite')
                if abs(start-start_pin)>.000001 or abs(end-end_pin)>.000001 or excerpt!=locator.get('excerpt'): raise SystemExit(f'{vid}: caption event clock or exact excerpt does not match source')
                marker=(rel,idx)
                if marker in seen or marker in global_locators: raise SystemExit(f'{vid}: duplicate caption locator')
                seen.add(marker); global_locators.add(marker)
                verified_locator={**locator,'start_s':start,'end_s':end,'excerpt':excerpt}
                addition={'source_path':rel,'source_file_identity':actual,'source_event_index':idx,'start_s':start,'end_s':end,'caption_text_copied':False}
                analysis_ref=locator.get('analysis_reference')
                if analysis_ref is not None:
                    if not isinstance(analysis_ref,dict) or not isinstance(analysis_ref.get('path'),str) or not analysis_ref.get('path'):
                        raise SystemExit(f'{vid}: analysis_reference requires a source path')
                    observation_id=analysis_ref.get('observation_id'); json_pointer=analysis_ref.get('json_pointer')
                    if ('observation_id' in analysis_ref)==('json_pointer' in analysis_ref): raise SystemExit(f'{vid}: analysis_reference requires exactly one observation_id or json_pointer')
                    if observation_id is not None and (not isinstance(observation_id,str) or not observation_id): raise SystemExit(f'{vid}: analysis_reference observation_id must be a nonempty string')
                    if json_pointer is not None and not isinstance(json_pointer,str): raise SystemExit(f'{vid}: analysis_reference json_pointer must be a string')
                    analysis_locator=Path(analysis_ref['path']); analysis_path=(analysis_locator if analysis_locator.is_absolute() else root/analysis_locator).resolve()
                    try: analysis_path.relative_to(root)
                    except ValueError: raise SystemExit(f'{vid}: analysis reference path escapes --root')
                    if not analysis_path.is_file() or analysis_ref.get('identity')!=identity(analysis_path): raise SystemExit(f'{vid}: analysis reference identity differs from its source file')
                    try: analysis_data=json.loads(analysis_path.read_text())
                    except (OSError,UnicodeDecodeError,json.JSONDecodeError) as exc: raise SystemExit(f'{vid}: analysis reference is not readable JSON: {exc}')
                    try:
                        if observation_id:
                            matches=[obj for obj in _walk_json_objects(analysis_data) if obj.get('id')==observation_id or obj.get('observation_id')==observation_id]
                            if len(matches)!=1: raise SystemExit(f'{vid}: analysis observation_id does not resolve uniquely')
                            observation=matches[0]
                        else: observation=_json_pointer_value(analysis_data,json_pointer)
                    except (ValueError,KeyError,IndexError) as exc: raise SystemExit(f'{vid}: analysis observation pointer does not resolve: {exc}')
                    if not _observation_contains_locator(observation,verified_locator): raise SystemExit(f'{vid}: selected caption locator is not present in the linked analysis observation')
                    stored_reference={'path':analysis_ref['path'],'identity':identity(analysis_path)}
                    if observation_id: stored_reference['observation_id']=observation_id
                    if json_pointer is not None: stored_reference['json_pointer']=json_pointer
                    addition['analysis_reference']=stored_reference
                additions.append(addition)
            if not additions: raise SystemExit(f'{vid}: {kind} has no new evidence locators')
            prior_snapshot[kind]=current
            patched[evidence_key]=old_refs+additions
            patched[status_key]=spec['status']; patched[interpretation_key]=spec['interpretation']; patched[qualification_key]=qualification
            field_status['opening_hook' if kind=='opening_hook' else 'internal_hooks']=f"{spec['status']}; caption event evidence only; excerpt retained in pinned source; speech/intent/effect not independently verified"
            changed.extend((evidence_key,status_key,interpretation_key,qualification_key,'field_status'))
        patched['field_status']=field_status
        if any(key not in ('opening_hook_evidence','opening_hook_status','opening_hook_interpretation','opening_hook_qualification','internal_hook_evidence','internal_hook_status','internal_hook_interpretation','internal_hook_qualification','field_status') and patched.get(key)!=value for key,value in row.items()): raise SystemExit(f'{vid}: hook update changed an unrelated row field')
        replacements[vid]=patched
        selected_preimages.append({'video_id':vid,'line_number':indexes[vid]+1,'selected_line_utf8_base64':base64.b64encode(lines[indexes[vid]]).decode('ascii')})
        receipts.append({'video_id':vid,'changed_fields':sorted(set(changed)),'prior_fields':prior_snapshot,'added_locators':sum(len(update[k].get('caption_locators',[])) for k in hooks),'caption_text_copied':False})
    output=[]
    for i,line in enumerate(lines):
        target=next((v for v,n in ((vid,indexes[vid]) for vid in replacements) if n==i),None)
        if target is None: output.append(line); continue
        ending=b'\r\n' if line.endswith(b'\r\n') else b'\n' if line.endswith(b'\n') else b''
        output.append(json.dumps(replacements[target],ensure_ascii=False,separators=(',',':')).encode('utf-8')+ending)
    candidate=b''.join(output)
    if len(output)!=len(lines): raise SystemExit('hook update changed JSONL line count')
    for i,(old,new) in enumerate(zip(lines,output)):
        if i not in {indexes[v] for v in replacements} and old!=new: raise SystemExit('non-target JSONL line bytes changed')
    if ledger.read_bytes()!=original: raise SystemExit('canonical ledger changed during hook-enrichment validation')
    after_candidate={'algorithm':'blake3','value':blake3_module.blake3(candidate).hexdigest(),'bytes':len(candidate)}
    preimage={'schema':'youtube-packaging-hook-enrichment-preimage@1','ledger_before':before,'source_key':source_key,'contract_identity':identity(contract_path),'selected_lines':selected_preimages}
    preimage_reused=False
    if preimage_path.exists():
        try: saved_preimage=json.loads(preimage_path.read_text())
        except (OSError,UnicodeDecodeError,json.JSONDecodeError) as exc: raise SystemExit(f'existing hook preimage is unreadable; refusing to replace it: {exc}')
        if saved_preimage!=preimage: raise SystemExit('existing hook preimage differs from this exact ledger/contract selection; refusing to replace it')
        preimage_reused=True
    else:
        preimage_path.parent.mkdir(parents=True,exist_ok=True); preimage_path.write_text(json.dumps(preimage,ensure_ascii=False,indent=2)+'\n')
    if apply:
        atomic_write_bytes(ledger,candidate); written=ledger.read_bytes()
        if written!=candidate: raise SystemExit('canonical ledger post-write bytes differ from validated candidate')
        final_identity={'algorithm':'blake3','value':blake3_module.blake3(written).hexdigest(),'bytes':len(written)}; status='applied'
    else:
        prospective_ledger=Path(prospective_ledger).resolve()
        atomic_write_bytes(prospective_ledger,candidate); final_identity=identity(prospective_ledger); status='prospective'
    current_lines=(ledger.read_bytes() if apply else candidate).splitlines(keepends=True)
    inverse_lines=list(current_lines)
    for item in selected_preimages: inverse_lines[item['line_number']-1]=base64.b64decode(item['selected_line_utf8_base64'],validate=True)
    inverse=b''.join(inverse_lines); inverse_identity={'algorithm':'blake3','value':blake3_module.blake3(inverse).hexdigest(),'bytes':len(inverse)}
    if inverse_identity!=before: raise SystemExit('selected-line inverse does not reconstruct the exact whole-ledger preimage')
    result={'schema':'youtube-packaging-hook-enrichment-readback@1','status':status,'contract_path':str(contract_path.relative_to(root)),'contract_identity':identity(contract_path),'ledger_path':str(ledger.relative_to(root)),'ledger_before':before,'ledger_after':final_identity,'candidate_identity':after_candidate,'source_key':source_key,'selected_row_count':len(updates),'row_count_before':len(rows),'row_count_after':len(rows),'non_target_jsonl_lines_byte_exact':True,'caption_text_copied':False,'preimage_path':str(preimage_path.relative_to(root)),'preimage_reused_without_overwrite':preimage_reused,'exact_inverse_reconstruction_identity':inverse_identity,'exact_inverse_verified':True,'targets':receipts}
    readback.parent.mkdir(parents=True,exist_ok=True); readback.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':status,'source_key':source_key,'target_count':len(updates),'ledger_after':final_identity,'exact_inverse_verified':True}))

def source_status_reconciliation(root,ledger,contract_path,readback,preimage_path,expected_ledger_blake3,prospective_ledger=None,apply=False):
    """Reconcile narrowly defined channel, description and review-status fields from pinned sources."""
    import base64
    import blake3 as blake3_module
    root=Path(root).resolve(); ledger=Path(ledger).resolve(); contract_path=Path(contract_path).resolve()
    readback=Path(readback).resolve(); preimage_path=Path(preimage_path).resolve()
    if not expected_ledger_blake3: raise SystemExit('--expected-ledger-blake3 is required for source/status reconciliation')
    if apply and prospective_ledger: raise SystemExit('--apply and --prospective-ledger cannot be combined')
    if not apply and not prospective_ledger: raise SystemExit('source/status reconciliation requires --prospective-ledger unless --apply is explicit')
    paths=[(ledger,'ledger'),(contract_path,'contract'),(readback,'readback'),(preimage_path,'preimage')]
    if prospective_ledger: paths.append((Path(prospective_ledger).resolve(),'prospective ledger'))
    if len({str(path) for path,_ in paths})!=len(paths): raise SystemExit('source/status reconciliation input/output paths must be distinct')
    for path,label in paths:
        try: path.relative_to(root)
        except ValueError: raise SystemExit(f'{label} path escapes --root')
    if readback.exists(): raise SystemExit('source/status readback destination already exists; refusing to overwrite')
    if prospective_ledger and Path(prospective_ledger).resolve().exists(): raise SystemExit('prospective ledger destination already exists; refusing to overwrite')
    original=ledger.read_bytes(); before={'algorithm':'blake3','value':blake3_module.blake3(original).hexdigest(),'bytes':len(original)}
    if before['value']!=expected_ledger_blake3: raise SystemExit('canonical ledger BLAKE3 differs from the required preimage')
    contract=json.loads(contract_path.read_text())
    if contract.get('schema')!='youtube-packaging-source-reconciliation@1': raise SystemExit('unsupported source/status reconciliation contract schema')
    source_key=contract.get('source_key'); updates=contract.get('updates')
    if not isinstance(source_key,str) or not source_key or not isinstance(updates,list) or not updates: raise SystemExit('reconciliation contract requires source_key and nonempty updates')
    lines=original.splitlines(keepends=True); rows=[]; indexes={}; by_id={}
    for i,line in enumerate(lines):
        if not line.strip(): continue
        row=json.loads(line); vid=row.get('video_id')
        if not isinstance(vid,str) or not vid or vid in indexes: raise SystemExit(f'duplicate or missing ledger video ID: {vid}')
        rows.append(row); indexes[vid]=i; by_id[vid]=row
    vids=[item.get('video_id') if isinstance(item,dict) else None for item in updates]
    if any(not isinstance(vid,str) or not vid for vid in vids) or len(vids)!=len(set(vids)): raise SystemExit('reconciliation updates must have distinct video IDs')
    def resolve_source(ref,label):
        if not isinstance(ref,dict) or not isinstance(ref.get('path'),str) or not ref.get('path'): raise SystemExit(f'{label} requires a pinned path')
        locator=Path(ref['path']); path=(locator if locator.is_absolute() else root/locator).resolve()
        try: path.relative_to(root)
        except ValueError: raise SystemExit(f'{label} path escapes --root')
        if not path.is_file(): raise SystemExit(f'{label} path is not an existing file')
        actual=file_identity(path)
        if ref.get('identity')!=actual: raise SystemExit(f'{label} BLAKE3 or byte-count differs from its pin')
        return path,actual
    replacements={}; selected_preimages=[]; receipts=[]
    for item in updates:
        vid=item['video_id']; row=by_id.get(vid)
        if row is None or row.get('source_key')!=source_key: raise SystemExit(f'{vid}: target is not an existing row under source_key')
        operations=item.get('operations')
        allowed={'channel_id_from_metadata','description_from_metadata','thumbnail_review_status','thumbnail_analysis_from_review'}
        if not isinstance(operations,list) or not operations or any(not isinstance(op,str) for op in operations) or len(operations)!=len(set(operations)) or not set(operations)<=allowed:
            raise SystemExit(f'{vid}: operations must be a nonempty unique list of supported source-derived operations')
        expected_prior=item.get('expected_prior_fields')
        if not isinstance(expected_prior,dict): raise SystemExit(f'{vid}: exact expected_prior_fields are required')
        required_prior={'source_channel_id'} if 'channel_id_from_metadata' in operations else set()
        if 'description_from_metadata' in operations: required_prior|={'description','field_status'}
        if 'thumbnail_review_status' in operations: required_prior.add('field_status')
        if 'thumbnail_analysis_from_review' in operations: required_prior.add('thumbnail_analysis')
        if set(expected_prior)!=required_prior: raise SystemExit(f'{vid}: expected_prior_fields must exactly match the selected operation scope')
        for key,expected in expected_prior.items():
            current=row.get(key)
            if current!=expected: raise SystemExit(f'{vid}: prior field {key} differs from its exact pin')
        field_status_value=row.get('field_status')
        if field_status_value is not None and not isinstance(field_status_value,dict): raise SystemExit(f'{vid}: field_status must be an object or null')
        current_fields=field_status_value or {}
        if 'field_status' in required_prior and not isinstance(current_fields,dict): raise SystemExit(f'{vid}: field_status must be an object')
        metadata_ref={'path':row.get('metadata_source_path'),'identity':item.get('metadata_identity')}
        metadata_path,metadata_identity=resolve_source(metadata_ref,f'{vid}: primary metadata')
        if row.get('metadata_source_identity') not in (None,metadata_identity): raise SystemExit(f'{vid}: retained metadata identity conflicts with the pinned primary metadata')
        metadata=json.loads(metadata_path.read_text())
        if not isinstance(metadata,dict): raise SystemExit(f'{vid}: primary metadata must be a JSON object')
        if metadata.get('id')!=vid: raise SystemExit(f'{vid}: primary metadata ID mismatch')
        row_title=row.get('metadata_title') or row.get('inventory_title')
        if not isinstance(row_title,str) or metadata.get('title')!=row_title: raise SystemExit(f'{vid}: primary metadata title does not join to the ledger row')
        metadata_channel=metadata.get('channel_id')
        metadata_channel_name=metadata.get('channel')
        if 'channel_id_from_metadata' in operations or 'description_from_metadata' in operations:
            if not isinstance(metadata_channel,str) or not metadata_channel or not isinstance(metadata_channel_name,str) or metadata_channel_name!=row.get('channel'):
                raise SystemExit(f'{vid}: primary metadata channel identity does not join to the ledger row')
        patched=dict(row); changed=[]; evidence_receipts={'metadata':{'path':str(metadata_path.relative_to(root)),'identity':metadata_identity}}
        if 'channel_id_from_metadata' in operations:
            catalog_path,catalog_identity=resolve_source(item.get('channel_catalog'),f'{vid}: channel catalog')
            catalog=json.loads(catalog_path.read_text())
            if not isinstance(catalog,dict): raise SystemExit(f'{vid}: channel catalog must be a JSON object')
            if catalog.get('channel_id')!=metadata_channel or catalog.get('channel_name')!=row.get('channel'):
                raise SystemExit(f'{vid}: pinned channel catalog conflicts with the primary metadata/channel row')
            if catalog_path.name!=f'{metadata_channel}.catalog.json': raise SystemExit(f'{vid}: channel catalog filename does not match metadata channel ID')
            catalog_entries=catalog.get('entries')
            if not isinstance(catalog_entries,list): raise SystemExit(f'{vid}: pinned channel catalog has no entry list')
            catalog_matches=[entry for entry in catalog_entries if isinstance(entry,dict) and entry.get('video_id')==vid]
            if len(catalog_matches)!=1 or catalog_matches[0].get('title')!=metadata.get('title'):
                raise SystemExit(f'{vid}: channel catalog does not uniquely own this video/title')
            current_channel=row.get('source_channel_id')
            if current_channel not in (None,metadata_channel): raise SystemExit(f'{vid}: existing source_channel_id conflicts with pinned primary metadata')
            patched['source_channel_id']=metadata_channel; changed.append('source_channel_id')
            evidence_receipts['channel_catalog']={'path':str(catalog_path.relative_to(root)),'identity':catalog_identity,'channel_id':metadata_channel,'channel_name':catalog['channel_name']}
        if 'description_from_metadata' in operations:
            description=metadata.get('description')
            if not isinstance(description,str) or not description.strip(): raise SystemExit(f'{vid}: pinned primary metadata has no nonempty description')
            current_description=row.get('description')
            if current_description not in (None,description): raise SystemExit(f'{vid}: existing description conflicts with pinned primary metadata')
            description_status=f'retained {metadata_path.name} description; uploader-supplied and not independently verified'
            old_status=current_fields.get('description')
            if old_status not in (None,'metadata source absent',description_status): raise SystemExit(f'{vid}: existing description field_status is not an eligible stale/current value')
            patched['description']=description
            fields=dict(current_fields); fields['description']=description_status; patched['field_status']=fields
            changed.extend(('description','field_status.description'))
        if 'thumbnail_review_status' in operations:
            review_path,review_identity=resolve_source(item.get('thumbnail_review'),f'{vid}: thumbnail review source')
            review=json.loads(review_path.read_text())
            if not isinstance(review,dict) or review.get('schema')!='thumbnail-review-observations@1' or not isinstance(review.get('records'),list):
                raise SystemExit(f'{vid}: unsupported pinned thumbnail review source schema')
            matches=[record for record in review['records'] if isinstance(record,dict) and record.get('video_id')==vid]
            if len(matches)!=1: raise SystemExit(f'{vid}: thumbnail review source must contain exactly one record for target')
            record=matches[0]; image_locator=record.get('thumbnail_original_path'); row_image=row.get('thumbnail_image_path')
            if not isinstance(image_locator,str) or not isinstance(row_image,str): raise SystemExit(f'{vid}: thumbnail review/image path missing')
            if record.get('visual_review_method')!='direct pixel display of retained local original':
                raise SystemExit(f'{vid}: pinned thumbnail record does not document direct original-image review')
            image_path=Path(image_locator).resolve(); row_image_path=Path(row_image).resolve()
            try: image_path.relative_to(root); row_image_path.relative_to(root)
            except ValueError: raise SystemExit(f'{vid}: reviewed thumbnail path escapes --root')
            if image_path!=row_image_path: raise SystemExit(f'{vid}: review image locator does not match retained ledger image')
            image_identity=file_identity(image_path); thumb=row.get('thumbnail_blake3')
            thumb_value=thumb.get('value') if isinstance(thumb,dict) else thumb
            if image_identity['value']!=thumb_value or image_identity['bytes']!=(thumb.get('bytes') if isinstance(thumb,dict) else record.get('thumbnail_bytes')):
                raise SystemExit(f'{vid}: retained image identity differs from the ledger or review record')
            if record.get('thumbnail_blake3')!=image_identity['value'] or record.get('thumbnail_bytes')!=image_identity['bytes']:
                raise SystemExit(f'{vid}: reviewed image identity differs from the exact retained image')
            review_title_path=record.get('source_title_provenance_path')
            if not isinstance(review_title_path,str) or Path(review_title_path).resolve()!=metadata_path: raise SystemExit(f'{vid}: review title source does not match primary metadata')
            words=row.get('thumbnail_words') or {}
            if not isinstance(words,dict) or words.get('status')!='directly reviewed': raise SystemExit(f'{vid}: retained thumbnail words are not directly reviewed')
            def word_texts(values):
                if not isinstance(values,list): return None
                result=[]
                for value in values:
                    text=value.get('text',value.get('thumbnail_text')) if isinstance(value,dict) else value
                    if not isinstance(text,str): return None
                    result.append(text)
                return result
            retained_text=word_texts(words.get('value')); reviewed_text=word_texts(record.get('visible_text'))
            analysis=row.get('thumbnail_words') or {}; reviewed_analysis={
                'composition':record.get('composition'),
                'title_thumbnail_role_relation':record.get('title_thumbnail_role_relation'),
            }
            if not retained_text or retained_text!=reviewed_text: raise SystemExit(f'{vid}: reviewed visible text differs from retained thumbnail words')
            if not isinstance(reviewed_analysis['composition'],str) or analysis.get('composition')!=reviewed_analysis['composition']:
                raise SystemExit(f'{vid}: reviewed composition differs from retained analysis')
            reviewed_analysis['title_thumbnail_role_relation']=record.get('title_relation')
            if not isinstance(reviewed_analysis['title_thumbnail_role_relation'],str) or analysis.get('title_thumbnail_role_relation')!=reviewed_analysis['title_thumbnail_role_relation']:
                raise SystemExit(f'{vid}: reviewed title relation differs from retained analysis')
            status_image='retained original image; BLAKE3 checked; directly reviewed'
            status_words='directly reviewed from the retained original; visible text and roles retained'
            if current_fields.get('thumbnail_image') not in (None,'image absent','unreviewed',status_image):
                raise SystemExit(f'{vid}: thumbnail_image field_status is not an eligible stale/current value')
            if current_fields.get('thumbnail_words') not in (None,'unreviewed',status_words):
                raise SystemExit(f'{vid}: thumbnail_words field_status is not an eligible stale/current value')
            fields=dict(patched.get('field_status') or current_fields); fields.update({'thumbnail_image':status_image,'thumbnail_words':status_words}); patched['field_status']=fields
            changed.extend(('field_status.thumbnail_image','field_status.thumbnail_words'))
            evidence_receipts['thumbnail_review']={'path':str(review_path.relative_to(root)),'identity':review_identity,'record_video_id':vid,'image_path':str(image_path.relative_to(root)),'image_identity':image_identity,'reviewed_text_count':len(reviewed_text)}
        if 'thumbnail_analysis_from_review' in operations:
            review_path,review_identity=resolve_source(item.get('thumbnail_review'),f'{vid}: thumbnail analysis source')
            review=json.loads(review_path.read_text())
            if not isinstance(review,dict) or review.get('schema')!='original22-thumbnail-review-batch@1' or not isinstance(review.get('records'),list):
                raise SystemExit(f'{vid}: unsupported thumbnail analysis review schema')
            matches=[record for record in review['records'] if isinstance(record,dict) and record.get('video_id')==vid]
            if len(matches)!=1: raise SystemExit(f'{vid}: thumbnail analysis source must uniquely identify the target')
            record=matches[0]
            if record.get('visual_review_status')!='directly inspected from retained local original':
                raise SystemExit(f'{vid}: thumbnail analysis source is not a retained direct review')
            image_path=Path(record.get('image_path','')).resolve()
            row_image=Path(row.get('thumbnail_image_path','')); row_image=(row_image if row_image.is_absolute() else root/row_image).resolve()
            if not image_path.is_relative_to(root) or image_path!=row_image or not image_path.is_file():
                raise SystemExit(f'{vid}: thumbnail analysis image does not join to the retained source')
            image_identity=file_identity(image_path); thumb=row.get('thumbnail_blake3')
            thumb_digest=thumb.get('value') if isinstance(thumb,dict) else thumb
            if record.get('image_blake3')!=image_identity['value'] or record.get('image_bytes')!=image_identity['bytes'] or thumb_digest!=image_identity['value']:
                raise SystemExit(f'{vid}: thumbnail analysis image identity mismatch')
            title_source=Path(record.get('title_source_path','')).resolve()
            if title_source!=metadata_path or record.get('title_source_blake3')!=metadata_identity['value'] or record.get('title_source_bytes')!=metadata_identity['bytes']:
                raise SystemExit(f'{vid}: thumbnail analysis metadata identity mismatch')
            def analysis_word_texts(values):
                return [value.get('text',value.get('thumbnail_text')) if isinstance(value,dict) else value for value in values]
            words=row.get('thumbnail_words') or {}
            if words.get('status')!='directly reviewed' or analysis_word_texts(words.get('value') or [])!=analysis_word_texts(record.get('visible_text') or []):
                raise SystemExit(f'{vid}: thumbnail analysis reviewed text differs from retained words')
            derived={key:record.get(key) for key in ('composition','title_thumbnail_role_relation')}
            if any(not isinstance(value,str) or not value for value in derived.values()):
                raise SystemExit(f'{vid}: thumbnail analysis source fields are incomplete')
            prior_analysis=row.get('thumbnail_analysis')
            if prior_analysis is not None and not isinstance(prior_analysis,dict): raise SystemExit(f'{vid}: existing thumbnail_analysis is malformed')
            for key,value in derived.items():
                if (prior_analysis or {}).get(key) not in (None,value): raise SystemExit(f'{vid}: existing thumbnail analysis conflicts with the pinned review')
            patched['thumbnail_analysis']={**(prior_analysis or {}),**derived,'source_review':str(review_path.relative_to(root))}
            changed.append('thumbnail_analysis')
            evidence_receipts['thumbnail_analysis']={'path':str(review_path.relative_to(root)),'identity':review_identity,'record_video_id':vid,'image_identity':image_identity}
        allowed_top={'source_channel_id','description','field_status','thumbnail_analysis'}
        if any(key not in allowed_top and patched.get(key)!=value for key,value in row.items()): raise SystemExit(f'{vid}: source/status reconciliation changed an unrelated row field')
        old_field_status=row.get('field_status') or {}; new_field_status=patched.get('field_status') or {}
        allowed_status=set()
        if 'description_from_metadata' in operations: allowed_status.add('description')
        if 'thumbnail_review_status' in operations: allowed_status|={'thumbnail_image','thumbnail_words'}
        if any(k not in allowed_status and old_field_status.get(k)!=v for k,v in new_field_status.items()): raise SystemExit(f'{vid}: source/status reconciliation changed an unrelated field_status entry')
        replacements[vid]=patched
        selected_preimages.append({'video_id':vid,'line_number':indexes[vid]+1,'selected_line_utf8_base64':base64.b64encode(lines[indexes[vid]]).decode('ascii')})
        receipts.append({'video_id':vid,'source_key':source_key,'operations':operations,'changed_fields':sorted(set(changed)),'source_evidence':evidence_receipts,'prior_fields':expected_prior,'caption_and_hook_evidence_preserved':all(patched.get(k)==v for k,v in row.items() if 'hook' in k or k=='caption_sources'),'description_text_copied_from_primary_metadata': 'description_from_metadata' in operations})
    output=[]
    selected_indexes={indexes[vid] for vid in replacements}
    for i,line in enumerate(lines):
        if i not in selected_indexes: output.append(line); continue
        vid=next(vid for vid in replacements if indexes[vid]==i)
        ending=b'\r\n' if line.endswith(b'\r\n') else b'\n' if line.endswith(b'\n') else b''
        output.append(json.dumps(replacements[vid],ensure_ascii=False,separators=(',',':')).encode('utf-8')+ending)
    candidate=b''.join(output)
    if len(output)!=len(lines): raise SystemExit('source/status reconciliation changed JSONL line count')
    if any(old!=new for i,(old,new) in enumerate(zip(lines,output)) if i not in selected_indexes): raise SystemExit('non-target JSONL line bytes changed')
    if ledger.read_bytes()!=original: raise SystemExit('ledger changed during source/status validation')
    after_candidate={'algorithm':'blake3','value':blake3_module.blake3(candidate).hexdigest(),'bytes':len(candidate)}
    preimage={'schema':'youtube-packaging-source-reconciliation-preimage@1','ledger_before':before,'source_key':source_key,'contract_identity':file_identity(contract_path),'selected_lines':selected_preimages}
    preimage_reused=False
    if preimage_path.exists():
        try: saved=json.loads(preimage_path.read_text())
        except (OSError,UnicodeDecodeError,json.JSONDecodeError) as exc: raise SystemExit(f'existing source/status preimage is unreadable; refusing to replace it: {exc}')
        if saved!=preimage: raise SystemExit('existing source/status preimage differs from this exact selection; refusing to replace it')
        preimage_reused=True
    else:
        preimage_path.parent.mkdir(parents=True,exist_ok=True); preimage_path.write_text(json.dumps(preimage,ensure_ascii=False,indent=2)+'\n')
    if apply:
        atomic_write_bytes(ledger,candidate); written=ledger.read_bytes()
        if written!=candidate: raise SystemExit('canonical post-write bytes differ from validated source/status candidate')
        final_identity={'algorithm':'blake3','value':blake3_module.blake3(written).hexdigest(),'bytes':len(written)}; status='applied'
    else:
        prospective_ledger=Path(prospective_ledger).resolve(); atomic_write_bytes(prospective_ledger,candidate)
        final_identity=file_identity(prospective_ledger); status='prospective'
    inverse_lines=list((ledger.read_bytes() if apply else candidate).splitlines(keepends=True))
    for item in selected_preimages: inverse_lines[item['line_number']-1]=base64.b64decode(item['selected_line_utf8_base64'],validate=True)
    inverse=b''.join(inverse_lines); inverse_identity={'algorithm':'blake3','value':blake3_module.blake3(inverse).hexdigest(),'bytes':len(inverse)}
    if inverse_identity!=before: raise SystemExit('source/status selected-line inverse does not reconstruct exact whole-ledger preimage')
    result={'schema':'youtube-packaging-source-reconciliation-readback@1','status':status,'contract_path':str(contract_path.relative_to(root)),'contract_identity':file_identity(contract_path),'ledger_path':str(ledger.relative_to(root)),'ledger_before':before,'ledger_after':final_identity,'candidate_identity':after_candidate,'source_key':source_key,'target_count':len(updates),'row_count_before':len(rows),'row_count_after':len(rows),'non_target_jsonl_lines_byte_exact':True,'caption_and_hook_evidence_preserved':True,'preimage_path':str(preimage_path.relative_to(root)),'preimage_reused_without_overwrite':preimage_reused,'exact_inverse_reconstruction_identity':inverse_identity,'exact_inverse_verified':True,'targets':receipts}
    readback.parent.mkdir(parents=True,exist_ok=True); readback.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':status,'source_key':source_key,'target_count':len(updates),'ledger_after':final_identity,'exact_inverse_verified':True}))

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--root',type=Path,required=True); ap.add_argument('--intake',type=Path); ap.add_argument('--channel-catalog',type=Path); ap.add_argument('--review',type=Path); ap.add_argument('--source-key'); ap.add_argument('--ledger',type=Path,required=True); ap.add_argument('--coverage',type=Path); ap.add_argument('--source-coverage',type=Path); ap.add_argument('--readback',type=Path); ap.add_argument('--update-existing',action='store_true',help='Apply a directly reviewed subset to existing unreviewed rows for the same source key and channel ID.'); ap.add_argument('--append-new',action='store_true',help='Append a new, disjoint reviewed batch to an existing source key/channel while preserving all existing ledger lines.'); ap.add_argument('--direct-review-batch',type=Path,help='Apply an identity-pinned thumbnail-review-batch-readback@1 to existing ledger rows.'); ap.add_argument('--identity-only-update',type=Path,help='Apply a source-key/metadata-locator identity-only update contract.'); ap.add_argument('--hook-enrichment',type=Path,help='Apply or stage a caption-evidence-pinned hook-enrichment contract.'); ap.add_argument('--source-reconciliation',type=Path,help='Apply or stage a pinned metadata/channel/review-status reconciliation contract.'); ap.add_argument('--preimage',type=Path,help='Write the selected original JSONL line and prior whole-ledger identity.'); ap.add_argument('--prospective-ledger',type=Path,help='Write a validated candidate without changing the canonical ledger.'); ap.add_argument('--apply',action='store_true',help='Write a validated hook or source-reconciliation candidate to the canonical ledger.'); ap.add_argument('--dry-run',action='store_true',help='Require --prospective-ledger and do not modify the canonical ledger.'); ap.add_argument('--expected-ledger-blake3',help='Require the canonical ledger to match this BLAKE3 preimage before updates.'); a=ap.parse_args()
    if a.hook_enrichment:
        if a.source_reconciliation or a.update_existing or a.append_new or a.direct_review_batch or a.identity_only_update or a.dry_run: raise SystemExit('--hook-enrichment cannot be combined with other update modes or --dry-run')
        if not a.readback or not a.preimage: raise SystemExit('--readback and --preimage are required with --hook-enrichment')
        hook_enrichment_update(a.root,a.ledger,a.hook_enrichment,a.readback,a.preimage,a.expected_ledger_blake3,a.prospective_ledger,a.apply)
        return
    if a.source_reconciliation:
        if a.update_existing or a.append_new or a.direct_review_batch or a.identity_only_update or a.dry_run: raise SystemExit('--source-reconciliation cannot be combined with other update modes or --dry-run')
        if not a.readback or not a.preimage: raise SystemExit('--readback and --preimage are required with --source-reconciliation')
        source_status_reconciliation(a.root,a.ledger,a.source_reconciliation,a.readback,a.preimage,a.expected_ledger_blake3,a.prospective_ledger,a.apply)
        return
    if a.apply: raise SystemExit('--apply is only valid with --hook-enrichment or --source-reconciliation')
    if a.identity_only_update:
        if a.update_existing or a.append_new or a.direct_review_batch or a.dry_run: raise SystemExit('--identity-only-update cannot be combined with intake or direct-review modes')
        if not a.readback or not a.preimage: raise SystemExit('--readback and --preimage are required with --identity-only-update')
        identity_only_update(a.root,a.ledger,a.identity_only_update,a.readback,a.preimage,a.expected_ledger_blake3)
        return
    if a.direct_review_batch:
        if a.update_existing or a.append_new: raise SystemExit('--direct-review-batch cannot be combined with intake modes')
        if not a.readback: raise SystemExit('--readback is required with --direct-review-batch')
        direct_review_batch(a.root,a.ledger,a.direct_review_batch,a.readback,a.prospective_ledger,a.dry_run,a.expected_ledger_blake3)
        return
    missing=[name for name,value in (('--intake',a.intake),('--channel-catalog',a.channel_catalog),('--review',a.review),('--source-key',a.source_key),('--coverage',a.coverage),('--source-coverage',a.source_coverage),('--readback',a.readback)) if value is None]
    if missing: raise SystemExit('required for intake mode: '+', '.join(missing))
    if a.update_existing and a.append_new: raise SystemExit('--append-new and --update-existing are mutually exclusive')
    root=a.root.resolve(); intake=a.intake.resolve(); catalog=a.channel_catalog.resolve(); review=a.review.resolve()
    intake_data=json.loads(intake.read_text()); cat=json.loads(catalog.read_text()); rev=json.loads(review.read_text())
    if not cat.get('channel_id') or not cat.get('channel_name'): raise SystemExit('channel catalog identity missing')
    def unique_map(records,label):
        result={x['video_id']:x for x in records}
        if len(result)!=len(records): raise SystemExit(f'duplicate video_id in {label}')
        return result
    items=unique_map(rev['items'],'review items'); entries=unique_map(cat['entries'],'channel catalog'); admitted=unique_map(intake_data['videos'],'intake manifest')
    ids=sorted(set(items)&set(entries)&set(admitted))
    if len(ids)!=len(items) or not ids: raise SystemExit('review/intake/catalog membership mismatch')
    source_summary={'source_key':a.source_key,'channel':cat['channel_name'],'imported_ids':len(ids),'title_present':len(ids),'description_present':0,'thumbnail_retained_unreviewed':0,'caption_files_joined':len(ids),'opening_caption_spans':0,'internal_hooks_analyzed':0,'thumbnail_words_reviewed':len(ids),'membership_source':str(intake.relative_to(root)),'channel_catalog':str(catalog.relative_to(root))}
    planned=[]
    for vid in ids:
        item=items[vid]; iv=admitted[vid]; entry=entries[vid]; img=Path(item['image_path']); img=(root/img).resolve() if not img.is_absolute() else img.resolve(); meta=(intake.parent/iv['metadata_path']).resolve(); transcript=(intake.parent/iv['transcript_path']).resolve()
        if not img.is_file() or img.stat().st_size!=item['image_bytes'] or blake3(img)!=item['image_blake3']: raise SystemExit(f'thumbnail identity mismatch: {vid}')
        if not meta.is_file() or not transcript.is_file(): raise SystemExit(f'missing admitted metadata or captions: {vid}')
        metadata_identity={'algorithm':'blake3','value':blake3(meta),'bytes':meta.stat().st_size}
        caption_identity={'algorithm':'blake3','value':blake3(transcript),'bytes':transcript.stat().st_size}
        caption_data=json.loads(transcript.read_text()); caption_events=caption_data.get('events',[])
        def evidence_refs(key):
            analysis=item.get(key) or {}
            refs=[]
            for sample in analysis.get('events',[]):
                idx=sample.get('event_index')
                if not isinstance(idx,int) or idx<0 or idx>=len(caption_events): raise SystemExit(f'caption event index outside source: {vid}:{idx}')
                event=caption_events[idx]; start=event.get('tStartMs',0)/1000; end=(event.get('tStartMs',0)+event.get('dDurationMs',0))/1000
                if abs(start-sample.get('start_s',start))>0.001 or abs(end-sample.get('end_s',end))>0.001: raise SystemExit(f'caption locator/time mismatch: {vid}:{idx}')
                refs.append({'source_path':str(transcript.relative_to(root)),'source_file_identity':{'algorithm':'blake3','value':caption_identity['value'],'bytes':caption_identity['bytes']},'source_event_index':idx,'normalized_segment_id':sample['normalized_segment_id'],'start_s':start,'end_s':end,'caption_text_copied':False})
            return refs,analysis
        opening_refs,opening_analysis=evidence_refs('opening_evidence')
        internal_refs,internal_analysis=evidence_refs('internal_hook_evidence')
        metadata=json.loads(meta.read_text())
        row={'video_id':vid,'source_key':a.source_key,'channel':cat['channel_name'],'kind':'video','url':entry['url'],'inventory_title':entry['title'],'view_count':None,'duration_s':str(entry.get('duration_seconds')) if entry.get('duration_seconds') is not None else None,'duplicate_inventory_rows':1,'description':metadata.get('description'),'metadata_title':iv['title'],'metadata_source_path':str(meta.relative_to(root)),'metadata_source_identity':metadata_identity,'thumbnail_image_path':str(img),'thumbnail_blake3':{'algorithm':'blake3','value':item['image_blake3'],'bytes':item['image_bytes']},'thumbnail_words':{'status':'directly reviewed','value':item['thumbnail_words']},'thumbnail_analysis':{'composition':item['composition'],'title_thumbnail_role_relation':item['title_thumbnail_relation'],'within_batch_pattern_sample':item.get('within_batch_pattern_sample'),'pattern_scope':item.get('pattern_scope'),'source_review':str(review.relative_to(root))},'thumbnail_review_provenance':{'image_path':str(img.relative_to(root)),'image_identity':{'algorithm':'blake3','value':item['image_blake3'],'bytes':item['image_bytes']},'title_source_path':str(meta.relative_to(root)),'title_source_identity':metadata_identity,'review_note':str(review.relative_to(root)),'caption_audio_verification':'not independently verified'},'source_channel_id':cat['channel_id'],'caption_sources':[str(transcript.relative_to(root))],'caption_source_identities':[{'path':str(transcript.relative_to(root)),'identity':caption_identity}],'opening_hook_evidence':opening_refs,'opening_hook_status':opening_analysis.get('status','not assessed'),'opening_hook_interpretation':opening_analysis.get('candidate_function'),'opening_hook_qualification':opening_analysis.get('qualification'),'internal_hook_evidence':internal_refs,'internal_hook_status':internal_analysis.get('status','not assessed'),'internal_hook_interpretation':internal_analysis.get('candidate_function'),'internal_hook_qualification':internal_analysis.get('qualification'),'field_status':{'title':'present','description':'metadata description retained by source reference; title/description identity checked','thumbnail_image':'retained; BLAKE3 checked','thumbnail_words':'directly reviewed','opening_hook':'caption source references only; caption text not copied; speech not independently verified','internal_hooks':'sampled caption source references only; not exhaustive; speech not independently verified'},'admission_provenance':{'intake_manifest':str(intake.relative_to(root)),'channel_catalog':str(catalog.relative_to(root)),'review_record':str(review.relative_to(root))}}
        planned.append(row)
    lines=[l for l in a.ledger.read_text().splitlines() if l.strip()]; old=[json.loads(l) for l in lines]; old_by={r['video_id']:r for r in old}
    if len(old_by)!=len(old): raise SystemExit('duplicate video IDs in current ledger')
    pby={r['video_id']:r for r in planned}
    if a.update_existing:
        target_keys={'metadata_title','metadata_source_path','metadata_source_identity','description','thumbnail_image_path','thumbnail_blake3','thumbnail_words','thumbnail_analysis','thumbnail_review_provenance','source_channel_id','caption_source_identities','opening_hook_evidence','opening_hook_status','opening_hook_interpretation','opening_hook_qualification','internal_hook_evidence','internal_hook_status','internal_hook_interpretation','internal_hook_qualification','field_status','admission_provenance'}
        merged=[]
        for row in planned:
            oldrow=old_by.get(row['video_id'])
            if not oldrow or oldrow.get('source_key')!=a.source_key or oldrow.get('channel')!=cat['channel_name'] or oldrow.get('source_channel_id') not in (None,cat['channel_id']):
                raise SystemExit(f'update-existing requires a current row for the same source key and channel ID: {row["video_id"]}')
            entry=entries[row['video_id']]
            if oldrow.get('inventory_title')!=entry['title']: raise SystemExit(f'catalog/ledger title mismatch: {row["video_id"]}')
            status=oldrow.get('thumbnail_words',{}).get('status')
            if status=='directly reviewed':
                if any(oldrow.get(key)!=row.get(key) for key in target_keys): raise SystemExit(f'target already reviewed with different admission/review data: {row["video_id"]}')
                updated=dict(oldrow)
            elif status=='unreviewed':
                updated=dict(oldrow)
                for key in target_keys: updated[key]=row.get(key)
            else: raise SystemExit(f'target thumbnail is not unreviewed or an exact prior application: {row["video_id"]}')
            merged.append(updated)
        planned=merged; pby={r['video_id']:r for r in planned}
    elif a.append_new:
        source_key_rows=[row for row in old if row.get('source_key')==a.source_key]
        if not source_key_rows: raise SystemExit('append-new requires existing ledger rows for the declared source key')
        for row in old:
            if row.get('source_key')==a.source_key and (row.get('channel')!=cat['channel_name'] or row.get('source_channel_id') not in (None,cat['channel_id'])):
                raise SystemExit(f'existing source key contains a conflicting channel owner: {row["video_id"]}')
        for vid,row in pby.items():
            existing=old_by.get(vid)
            if existing and (existing.get('source_key')!=a.source_key or existing!=row):
                raise SystemExit(f'append-new target ID is already owned by a conflicting ledger row: {vid}')
        existing_source=[r for r in json.loads(a.source_coverage.read_text()) if r.get('source_key')==a.source_key]
        if len(existing_source)!=1 or existing_source[0].get('channel')!=cat['channel_name']:
            raise SystemExit('append-new requires one current source-coverage owner for the same channel')
        conflicting_coverage=[r for r in json.loads(a.coverage.read_text()).get('separately_admitted_sources',[]) if r.get('source_key')==a.source_key and r.get('channel')!=cat['channel_name']]
        if conflicting_coverage: raise SystemExit('append-new found a separately admitted source-key channel conflict')
    else:
        for vid,oldrow in old_by.items():
            if vid in pby and (oldrow.get('source_key')!=a.source_key or oldrow.get('admission_provenance')!=pby[vid]['admission_provenance']): raise SystemExit(f'conflicting existing row: {vid}')
            if oldrow.get('source_key')==a.source_key and vid not in pby: raise SystemExit('source key already has rows outside this declared intake batch')
    sourcecov=json.loads(a.source_coverage.read_text()); coverage=json.loads(a.coverage.read_text()); covrows=coverage.setdefault('separately_admitted_sources',[])
    if not a.update_existing and not a.append_new:
        for arr in (sourcecov,covrows):
            for row in arr:
                if row.get('source_key')==a.source_key and (row.get('membership_source')!=source_summary['membership_source'] or row.get('channel_catalog')!=source_summary['channel_catalog']): raise SystemExit('conflicting existing source coverage identity')
    source_exists=any(r['source_key']==a.source_key for r in sourcecov); cover_exists=any(r.get('source_key')==a.source_key for r in covrows)
    if a.update_existing:
        before_by={r['video_id']:r for r in old}
        batch={'review_record':str(review.relative_to(root)),'review_identity':{'algorithm':'blake3','value':blake3(review),'bytes':review.stat().st_size},'intake_manifest':str(intake.relative_to(root)),'intake_identity':{'algorithm':'blake3','value':blake3(intake),'bytes':intake.stat().st_size},'channel_catalog':str(catalog.relative_to(root)),'channel_catalog_identity':{'algorithm':'blake3','value':blake3(catalog),'bytes':catalog.stat().st_size},'video_ids':ids,'thumbnail_words_reviewed':len(ids),'opening_hook_event_references':sum(len(r.get('opening_hook_evidence',[])) for r in planned),'internal_hook_event_references':sum(len(r.get('internal_hook_evidence',[])) for r in planned),'internal_hooks_analyzed':sum(1 for r in planned if r.get('internal_hook_interpretation')),'caption_text_copied':False}
        def append_or_verify_batch(records):
            matches=[b for b in records if b.get('review_record')==batch['review_record']]
            for existing in matches:
                for key in ('review_identity','intake_manifest','intake_identity','channel_catalog','channel_catalog_identity','video_ids'):
                    if existing.get(key)!=batch.get(key): raise SystemExit('same review path is already recorded with a different source identity or scope')
            if not matches: records.append(batch)
        for arr in (sourcecov,):
            matches=[r for r in arr if r.get('source_key')==a.source_key]
            if len(matches)!=1: raise SystemExit('update-existing needs one current source coverage record')
            target=matches[0]; batches=target.setdefault('direct_review_batches',[]); append_or_verify_batch(batches)
            source_rows=[r for r in planned]+[r for r in old if r.get('source_key')==a.source_key and r['video_id'] not in pby]
            reviewed_count=sum(1 for r in source_rows if r.get('thumbnail_words',{}).get('status')=='directly reviewed')
            opening_count=sum(len(r.get('opening_hook_evidence',[])) for r in source_rows)
            internal_count=sum(1 for r in source_rows if r.get('internal_hook_interpretation'))
            target.update({'imported_ids':len(source_rows),'title_present':sum(1 for r in source_rows if r.get('metadata_title') or r.get('inventory_title')),'caption_files_joined':sum(1 for r in source_rows if r.get('caption_sources')),'directly_reviewed_thumbnail_rows':reviewed_count,'thumbnail_words_reviewed':reviewed_count,'opening_caption_spans':opening_count,'internal_hooks_analyzed':internal_count,'description_present':sum(1 for r in source_rows if r.get('description'))})
        append_or_verify_batch(coverage.setdefault('direct_review_batches',[]))
        new_sourcecov=sourcecov; new_covrows=covrows
    elif a.append_new:
        source_rows=[r for r in old if r.get('source_key')==a.source_key]
        source_rows.extend(r for r in planned if r['video_id'] not in old_by)
        sourcecov_row=next(r for r in sourcecov if r['source_key']==a.source_key)
        sourcecov_row.update({'imported_ids':len(source_rows),'title_present':sum(1 for r in source_rows if r.get('metadata_title') or r.get('inventory_title')),'description_present':sum(1 for r in source_rows if r.get('description')),'thumbnail_retained_unreviewed':sum(1 for r in source_rows if r.get('thumbnail_words',{}).get('status')!='directly reviewed'),'caption_files_joined':sum(1 for r in source_rows if r.get('caption_sources')),'opening_caption_spans':sum(len(r.get('opening_hook_evidence',[])) for r in source_rows),'internal_hooks_analyzed':sum(1 for r in source_rows if r.get('internal_hook_interpretation')),'thumbnail_words_reviewed':sum(1 for r in source_rows if r.get('thumbnail_words',{}).get('status')=='directly reviewed')})
        batch={'operation':'append-new','source_key':a.source_key,'channel':cat['channel_name'],'review_record':str(review.relative_to(root)),'review_identity':{'algorithm':'blake3','value':blake3(review),'bytes':review.stat().st_size},'intake_manifest':str(intake.relative_to(root)),'intake_identity':{'algorithm':'blake3','value':blake3(intake),'bytes':intake.stat().st_size},'channel_catalog':str(catalog.relative_to(root)),'channel_catalog_identity':{'algorithm':'blake3','value':blake3(catalog),'bytes':catalog.stat().st_size},'video_ids':ids,'added_video_ids':[vid for vid in ids if vid not in old_by],'thumbnail_words_reviewed':len(ids),'opening_hook_event_references':sum(len(r.get('opening_hook_evidence',[])) for r in planned),'internal_hook_event_references':sum(len(r.get('internal_hook_evidence',[])) for r in planned),'internal_hooks_analyzed':sum(1 for r in planned if r.get('internal_hook_interpretation')),'caption_text_copied':False}
        def append_or_verify_batch(records):
            matches=[b for b in records if b.get('review_record')==batch['review_record'] and b.get('operation')=='append-new']
            for existing in matches:
                for key in ('review_identity','intake_manifest','intake_identity','channel_catalog','channel_catalog_identity','video_ids'):
                    if existing.get(key)!=batch.get(key): raise SystemExit('same append review path is already recorded with a different identity or scope')
                if batch['added_video_ids'] and existing.get('added_video_ids')!=batch['added_video_ids']:
                    raise SystemExit('same append review path is already recorded with a different addition set')
                if not set(existing.get('added_video_ids',[]))<=set(ids):
                    raise SystemExit('same append review path is already recorded with a different addition set')
            if not matches: records.append(batch)
        append_or_verify_batch(sourcecov_row.setdefault('direct_review_batches',[]))
        append_or_verify_batch(coverage.setdefault('direct_review_batches',[]))
        new_sourcecov=sourcecov; new_covrows=covrows
    else:
        new_sourcecov=[source_summary if r['source_key']==a.source_key else r for r in sourcecov] if source_exists else sourcecov+[source_summary]
        new_covrows=[source_summary if r.get('source_key')==a.source_key else r for r in covrows] if cover_exists else covrows+[source_summary]
        coverage['separately_admitted_sources']=new_covrows
    # Append-new writes only a byte suffix; every existing ledger byte and line remains exact.
    if a.append_new:
        original_ledger=a.ledger.read_bytes()
        added=[json.dumps(r,ensure_ascii=False,separators=(',',':')).encode('utf-8') for r in planned if r['video_id'] not in old_by]
        if added:
            separator=b'' if not original_ledger or original_ledger.endswith(b'\n') else b'\n'
            ledger_output=original_ledger+separator+b'\n'.join(added)+b'\n'
        else:
            ledger_output=original_ledger
    else:
        merged=[]; emitted=set()
        for line,row in zip(lines,old):
            if row['video_id'] in pby:
                merged.append(json.dumps(pby[row['video_id']],ensure_ascii=False,separators=(',',':'))); emitted.add(row['video_id'])
            else: merged.append(line)
        merged.extend(json.dumps(r,ensure_ascii=False,separators=(',',':')) for r in planned if r['video_id'] not in emitted)
        ledger_output=('\n'.join(merged)+'\n').encode('utf-8')
    # Coverage-first ordering allows exact idempotent recovery if interrupted before ledger replace.
    atomic_write(a.coverage,json.dumps(coverage,ensure_ascii=False,indent=2)+'\n')
    atomic_write(a.source_coverage,json.dumps(new_sourcecov,ensure_ascii=False,indent=2)+'\n')
    atomic_write_bytes(a.ledger,ledger_output)
    after=[json.loads(l) for l in a.ledger.read_text().splitlines() if l.strip()]; afterby={r['video_id']:r for r in after}
    assert len(after)==len(old)+sum(1 for r in planned if r['video_id'] not in old_by)
    assert all(afterby[r['video_id']]==r for r in planned)
    assert all(afterby[r['video_id']]==r for r in old if r['video_id'] not in pby)
    a.readback.parent.mkdir(parents=True,exist_ok=True)
    a.readback.write_text(json.dumps({'schema':'youtube-packaging-intake-ledger-readback@1','operation':'append-new' if a.append_new else 'update-existing' if a.update_existing else 'insert-new-source','source_key':a.source_key,'source_membership':source_summary['membership_source'],'channel_catalog':source_summary['channel_catalog'],'video_ids':ids,'added_video_ids':[vid for vid in ids if vid not in old_by],'ledger_rows_before':len(old),'ledger_rows_after':len(after),'old_non_target_rows_preserved':True,'caption_text_copied':False},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'videos':len(ids),'rows_before':len(old),'rows_after':len(after),'all_old_non_target_rows_preserved':True,'source_key':a.source_key,'operation':'append-new' if a.append_new else 'update-existing' if a.update_existing else 'insert-new-source'}))
if __name__=='__main__': main()
