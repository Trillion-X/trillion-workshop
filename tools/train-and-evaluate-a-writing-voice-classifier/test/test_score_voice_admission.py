"""Observed regressions: malformed DATA and missing progress parent fail before weights."""
import importlib.util
import stand_in_decider
stand_in_decider.install()
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'do-work' / 'score-voice-adapter.py'
SPEC = importlib.util.spec_from_file_location('score_admission', SOURCE)
SCORER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCORER)


def data(split='eval'):
    return {'schema':'book-voice-decider-challenge-v3','criteria':[{
        'id':'reader-fit','question':'Does the explanation name the object?',
        'primitive':'one-of','options':[{'name':'pass'},{'name':'fail'}],
        'reference_context':'Check literal reader context and target.','applies_to':['paragraph'],
    }], 'items':[{'id':'case-one','family':'example-one','split':split,
        'source_kind':'constructed_regression','block_kind':'paragraph',
        'text':'The package contains twelve pencils.','reader_context':''}]}


class MaintainedAdmissionTests(unittest.TestCase):
    def test_real_maintained_validator_accepts_both_explicit_modes(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'input.json'
            for split,role,mode in [('eval','editorial-development','scoring-evaluation'),
                ('unlabeled','private-notebook-review','unlabeled')]:
                p.write_text(json.dumps(data(split)))
                r=SCORER.validate_challenge_file(p,role,mode=mode)
                self.assertEqual((r['mode'],r['items'],r['requests']),(mode,1,1))

    def test_role_text_cannot_select_unlabeled_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'input.json'
            p.write_text(json.dumps(data('unlabeled')))
            with self.assertRaisesRegex(ValueError,'rejected DATA before model loading'):
                SCORER.validate_challenge_file(p,'unlabeled_manuscript_diagnostic')
            r=SCORER.validate_challenge_file(p,'arbitrary-role',mode='unlabeled')
            self.assertEqual(r['mode'],'unlabeled')

    def test_mixed_splits_are_refused_and_validation_uses_supplied_snapshot_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'input.json';d=data()
            d['items'].append(dict(d['items'][0],id='case-two',family='example-two',split='unlabeled',
                                   checks={'reader-fit':'pass'}))
            p.write_text(json.dumps(d))
            with self.assertRaisesRegex(ValueError,'rejected DATA before model loading'):
                SCORER.validate_challenge_file(p,'editorial-development')
            # The live path differs; the actual bytes supplied for scoring remain valid.
            r=SCORER.validate_challenge_file(p,'editorial-development',raw_bytes=json.dumps(data()).encode())
            self.assertEqual(r['items'],1)

    def test_unlabeled_input_cannot_enter_evaluation_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'input.json';p.write_text(json.dumps(data('unlabeled')))
            with self.assertRaisesRegex(ValueError,'rejected DATA before model loading'):
                SCORER.validate_challenge_file(p,'editorial-development')

    def test_actual_cli_path_rejects_missing_origin_before_weights_and_prepares_progress_parent(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);p=root/'input.json';d=data();del d['items'][0]['source_kind']
            p.write_text(json.dumps(d));adapter=root/'adapter';adapter.mkdir()
            weights=adapter/'adapter_model.safetensors';weights.write_bytes(b'not model weights')
            model_path, owner_dir, model = stand_in_decider.write_model_config(root)
            (adapter/'train-info.json').write_text(json.dumps({
                'adapter_model_blake3':SCORER.digest(weights),'base_snapshot':str(SCORER.common.MODEL),
                'frame':SCORER.common.FRAME,'device':SCORER.common.DEVICE,
                'ready_identity':model['ready']['identity'],'model_record':model['model_record'],
                'ready_record':model['ready_record']}))
            output=root/'not-created'/'nested'/'score.json'
            argv=['scorer','--common-dir',str(Path(__file__).parent),'--model-config',str(model_path),
                  '--model-owner-dir',str(owner_dir),'--data',str(p),'--adapter',str(adapter),'--out',str(output),
                  '--dataset-role','editorial-development']
            with patch.object(SCORER.sys,'argv',argv),patch.object(SCORER.common,'load') as load:
                with self.assertRaisesRegex(ValueError,'rejected DATA before model loading'):
                    SCORER.main()
                load.assert_not_called()
            self.assertTrue(output.parent.is_dir())
            self.assertFalse(output.exists())

    def test_receipt_bound_exposure_finds_target_in_training_context(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'training-source.json';training=data()
            target='Previously rejected complete paragraph.'
            training['items'][0]['reader_context']='Earlier text. '+target+' Following text.'
            p.write_text(json.dumps(training))
            receipt={'rows':1,'provenance':{'row_ids':['case-one'],'source_dataset':{
                'path':str(p),'blake3':SCORER.digest(p),'criterion_id':'reader-fit'}}}
            evaluation=data();evaluation['items'][0]['text']=target
            rows=SCORER.adapt_v3(evaluation)
            result=SCORER.exposure_from_receipt(receipt,rows,{'path':'declared-target','blake3':'b'*64})
            self.assertTrue(result['source_projection']['source_bytes_verified'])
            self.assertEqual(result['text_matches'],[{'target_row_index':0,
                'training_row_index':0,'field_key':'reader_context','match':'exact_substring'}])
            self.assertEqual(result['unassessed_targets'],[])
            receipt['rows']=2
            with self.assertRaisesRegex(ValueError,'does not match'):
                SCORER.exposure_from_receipt(receipt,rows,{})
            receipt['provenance']['source_dataset']['blake3']='a'*64
            with self.assertRaisesRegex(ValueError,'source changed'):
                SCORER.exposure_from_receipt(receipt,rows,{})

    def test_portable_receipt_audits_only_explicitly_supplied_identity_bound_source_data(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source_path=root/'source.json';source=data()
            target='Previously rejected complete paragraph.'
            source['items'][0]['reader_context']='Earlier text. '+target+' Following text.'
            source_path.write_text(json.dumps(source),encoding='utf-8')
            source_hash=SCORER.digest(source_path)
            receipt={'rows':1,'provenance':{'schema':'book-voice-training-provenance-v2',
                'criterion_id':'reader-fit','row_ids':['case-one'],'source_dataset':{
                    'identity':'1f:'+source_hash,'blake3':source_hash,'schema':'book-voice-decider-challenge-v3'}}}
            evaluation=data();evaluation['items'][0]['text']=target
            rows=SCORER.adapt_v3(evaluation)
            result=SCORER.exposure_from_receipt(receipt,rows,{},training_source_path=source_path,
                supplied_source_blake3=source_hash)
            self.assertTrue(result['source_projection']['source_bytes_verified'])
            self.assertEqual(result['text_matches'][0]['field_key'],'reader_context')
            self.assertEqual(result['training_source']['status'],'caller_declared')
            source_path.write_text(json.dumps(data()),encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'source changed from its receipt identity'):
                SCORER.exposure_from_receipt(receipt,rows,{},training_source_path=source_path,
                    supplied_source_blake3=source_hash)

    def test_current_receipt_audits_train_sources_without_scoring_or_relabelling_them(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'source.json';source=data('train')
            evaluation=data();evaluation['items'][0].update(id='held-out',family='held-out-family',text='A separate held-out passage.')
            source['items'].append(evaluation['items'][0])
            before=json.dumps(source);p.write_text(before)
            receipt={'schema':'book-voice-adapter-training-receipt-v2','rows':1,'provenance':{
                'criterion_id':'reader-fit','row_ids':['case-one'],'source_dataset':{
                    'identity':'1f:'+SCORER.digest(p),'blake3':SCORER.digest(p)}}}
            result=SCORER.exposure_from_receipt(receipt,SCORER.adapt_v3(evaluation),{},training_source_path=p)
            self.assertTrue(result['source_projection']['source_bytes_verified'])
            self.assertEqual(result['text_matches'],[])
            self.assertEqual(result['same_family_matches'],[])
            self.assertEqual(p.read_text(),before)
            with self.assertRaisesRegex(ValueError,'only eval or unlabeled'):
                SCORER.adapt_v3(source)
            receipt['provenance']['row_ids']=['held-out']
            with self.assertRaisesRegex(ValueError,'cannot bind evaluation'):
                SCORER.exposure_from_receipt(receipt,SCORER.adapt_v3(evaluation),{},training_source_path=p)

    def test_missing_training_provenance_is_unassessed_not_disjoint(self):
        result=SCORER.exposure_from_receipt({},SCORER.adapt_v3(data()),{})
        self.assertFalse(result['source_projection']['source_bytes_verified'])
        self.assertEqual(result['source_projection']['status'],'missing_receipt_source_dataset')
        self.assertEqual(result['unassessed_targets'],[
            {'target_row_index':0,'reasons':['empty_training_rows']}])

    def test_mixed_criterion_receipt_projects_only_its_ordered_hash_bound_subset(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source_path=root/'source.json';provenance_path=root/'provenance.json'
            source={
                'schema':SCORER.CHALLENGE_SCHEMA,
                'criteria':[
                    {'id':'heading-order','primitive':'one-of','question':'Is the heading ordered?',
                     'options':[{'name':'pass'},{'name':'fail'}],'applies_to':['heading'],
                     'reference_context':'Heading order reference.'},
                    {'id':'heading-voice','primitive':'one-of','question':'Does the heading fit?',
                     'options':[{'name':'pass'},{'name':'fail'}],'applies_to':['heading'],
                     'reference_context':'Heading voice reference.'},
                    {'id':'voice','primitive':'one-of','question':'Does the prose fit?',
                     'options':[{'name':'pass'},{'name':'fail'}],'applies_to':['paragraph'],
                     'reference_context':'Voice reference.'},
                    {'id':'table-coverage','primitive':'one-of','question':'Is the table complete?',
                     'options':[{'name':'pass'},{'name':'fail'}],'applies_to':['table'],
                     'reference_context':'Table reference.'},
                ],
                'items':[
                    {'id':'heading','family':'heading-family','split':'eval','block_kind':'heading',
                     'text':'Target phrase meaningful.','reader_context':''},
                    {'id':'prose','family':'prose-family','split':'eval','block_kind':'paragraph',
                     'text':'Ordinary source prose.','reader_context':''},
                    {'id':'table','family':'table-family','split':'eval','block_kind':'table',
                     'text':'| A | B |','reader_context':''},
                    {'id':'not-trained','family':'extra','split':'eval','block_kind':'paragraph',
                     'text':'This source item is outside the receipt subset.','reader_context':''},
                ],
            }
            source_path.write_text(json.dumps(source),encoding='utf-8')
            source_hash=SCORER.digest(source_path)
            bindings=[('training-1','prose','voice'),('training-2','heading','heading-voice'),
                      ('training-3','table','table-coverage'),('training-4','heading','heading-order')]
            source_items={item['id']:item for item in source['items']}
            provenance_rows=[{'training_row_id':training_id,'source_item_id':item_id,
                'criterion_id':criterion_id,'family':source_items[item_id]['family'],
                'text':source_items[item_id]['text'],'state':{},'question':'Q',
                'options':[],'gold_check':'pass'}
                for training_id,item_id,criterion_id in bindings]
            source_provenance={'schema':'book-voice-training-provenance-v3',
                'source_dataset':str(source_path),'source_dataset_blake3':source_hash,
                'request_projection_policy':'maintained-requestPlan-multi-criterion-per-row-v1',
                'rows':provenance_rows}
            provenance_path.write_text(json.dumps(source_provenance),encoding='utf-8')
            provenance_hash=SCORER.digest(provenance_path)
            receipt={'rows':len(bindings),'provenance':{
                'identity':'1f:'+provenance_hash,
                'source_dataset':{'identity':'1f:'+source_hash,'blake3':source_hash,
                    'schema':'book-voice-training-provenance-v3',
                    'criterion_ids':sorted({row[2] for row in bindings}),
                    'training_row_ids':[row[0] for row in bindings]},
                'schema':'book-voice-training-provenance-v3',
                'request_projection_policy':'maintained-requestPlan-multi-criterion-per-row-v1',
                'training_row_ids':[row[0] for row in bindings],
                'source_item_ids':[row[1] for row in bindings],
                'criterion_ids':[row[2] for row in bindings],
                'families':sorted({source_items[row[1]]['family'] for row in bindings}),
            }}
            target_data=data();target_data['items'][0]['text']='Target phrase meaningful.'
            target_rows=SCORER.adapt_v3(target_data)
            result=SCORER.exposure_from_receipt(receipt,target_rows,{'path':'target','blake3':'b'*64},
                training_source_path=source_path,training_provenance_path=provenance_path,
                supplied_source_blake3=source_hash,supplied_provenance_blake3=provenance_hash)
            self.assertEqual(result['source_projection']['status'],
                             'receipt_bound_multi_criterion_v3_source_projection')
            self.assertEqual(result['training_row_count'],4)
            self.assertEqual(result['text_matches'][0]['training_row_index'],1)
            self.assertIn('only the receipt-declared training subset',result['source_projection']['scope'])

            duplicate=json.loads(json.dumps(receipt))
            duplicate['provenance']['training_row_ids'][1]='training-1'
            with self.assertRaisesRegex(ValueError,'duplicate, or miscounted'):
                SCORER.exposure_from_receipt(duplicate,target_rows,{},training_source_path=source_path,
                    training_provenance_path=provenance_path)
            duplicate_pair=json.loads(json.dumps(receipt))
            duplicate_pair['provenance']['source_item_ids'][1]='prose'
            duplicate_pair['provenance']['criterion_ids'][1]='voice'
            with self.assertRaisesRegex(ValueError,'duplicate, or miscounted'):
                SCORER.exposure_from_receipt(duplicate_pair,target_rows,{},training_source_path=source_path,
                    training_provenance_path=provenance_path)
            omitted=json.loads(json.dumps(receipt))
            omitted['provenance']['criterion_ids'].pop()
            with self.assertRaisesRegex(ValueError,'missing, duplicate, or miscounted'):
                SCORER.exposure_from_receipt(omitted,target_rows,{},training_source_path=source_path,
                    training_provenance_path=provenance_path)
            reordered=json.loads(json.dumps(receipt))
            reordered['provenance']['source_item_ids'][0],reordered['provenance']['source_item_ids'][1]=(
                reordered['provenance']['source_item_ids'][1],reordered['provenance']['source_item_ids'][0])
            with self.assertRaisesRegex(ValueError,'out of order'):
                SCORER.exposure_from_receipt(reordered,target_rows,{},training_source_path=source_path,
                    training_provenance_path=provenance_path)
            source_path.write_text(json.dumps({**source,'items':source['items'][:-1]}),encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'source changed'):
                SCORER.exposure_from_receipt(receipt,target_rows,{},training_source_path=source_path,
                    training_provenance_path=provenance_path)

    def test_preflight_cli_writes_a_distinct_noninference_receipt_without_loading_weights(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);p=root/'input.json';d=data()
            d['items'][0]['checks']={'reader-fit':'pass'}
            p.write_text(json.dumps(d))
            adapter=root/'adapter';adapter.mkdir()
            weights=adapter/'adapter_model.safetensors';weights.write_bytes(b'not model weights')
            model_path, owner_dir, model = stand_in_decider.write_model_config(root)
            (adapter/'train-info.json').write_text(json.dumps({
                'adapter_model_blake3':SCORER.digest(weights),'base_snapshot':str(SCORER.common.MODEL),
                'frame':SCORER.common.FRAME,'device':SCORER.common.DEVICE,
                'ready_identity':model['ready']['identity'],'model_record':model['model_record'],
                'ready_record':model['ready_record']}))
            output=root/'new'/'preflight.json'
            argv=['scorer','--common-dir',str(Path(__file__).parent),'--model-config',str(model_path),
                  '--model-owner-dir',str(owner_dir),'--data',str(p),'--adapter',str(adapter),'--out',str(output),
                  '--dataset-role','editorial-development','--preflight-only']
            with patch.object(SCORER.sys,'argv',argv),patch.object(SCORER.common,'load') as load:
                SCORER.main();load.assert_not_called()
            report=json.loads(output.read_text())
            self.assertEqual(report['schema'],'book-voice-isolated-input-preflight-v1')
            self.assertFalse(report['model_loaded']);self.assertFalse(report['inference'])
            self.assertEqual(report['input_validation']['items'],1)
            self.assertFalse(output.with_suffix('.progress.json').exists())

    def test_input_change_after_initial_hash_refuses_before_loading_weights(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);p=root/'input.json';p.write_text(json.dumps(data()))
            adapter=root/'adapter';adapter.mkdir();weights=adapter/'adapter_model.safetensors'
            weights.write_bytes(b'not model weights')
            model_path, owner_dir, model = stand_in_decider.write_model_config(root)
            (adapter/'train-info.json').write_text(json.dumps({
                'adapter_model_blake3':SCORER.digest(weights),'base_snapshot':str(SCORER.common.MODEL),
                'frame':SCORER.common.FRAME,'device':SCORER.common.DEVICE,
                'ready_identity':model['ready']['identity'],'model_record':model['model_record'],
                'ready_record':model['ready_record']}))
            original_digests=SCORER.digests
            def change_after_hash(paths):
                hashes=original_digests(paths)
                changed=data();changed['items'][0]['text']='A concurrent writer replaced this explanation.'
                p.write_text(json.dumps(changed));return hashes
            argv=['scorer','--common-dir',str(Path(__file__).parent),'--model-config',str(model_path),
                  '--model-owner-dir',str(owner_dir),'--data',str(p),'--adapter',str(adapter),'--out',str(root/'new'/'report.json'),
                  '--dataset-role','editorial-development','--preflight-only']
            with patch.object(SCORER.sys,'argv',argv),patch.object(SCORER,'digests',side_effect=change_after_hash),\
                    patch.object(SCORER.common,'load') as load:
                with self.assertRaisesRegex(ValueError,'DATA changed before snapshot'):
                    SCORER.main()
                load.assert_not_called()


if __name__=='__main__':
    unittest.main()
