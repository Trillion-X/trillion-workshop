"""Owned local voice-script entry point; this does not invoke installed Showtime.

The adopted library supplies script composition, alignment, mastering and readback.
The existing Trillion speaker supplies voice lookup/reference/synthesis. The
entry point cannot install dependencies or load ambient engine/source plugins.
"""
from pathlib import Path
import argparse
import json
import os
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'lib'))
os.environ['SHOWTIME_SKILL'] = str(ROOT)
os.environ['SHOWTIME_OFFLINE'] = '1'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['SHOWTIME_NO_CACHE'] = '1'
os.environ.pop('SHOWTIME_ENGINE_PATH', None)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    voice = commands.add_parser('voice').add_subparsers(dest='operation', required=True)
    script = voice.add_parser('script')
    script.add_argument('input')
    script.add_argument('-o', '--output', required=True)
    asr = commands.add_parser('asr').add_subparsers(dest='operation', required=True)
    inspect = asr.add_parser('inspect', help='Inspect declared local ASR dependencies without loading models or installing anything')
    inspect.add_argument('--lang', default='en')
    recheck = asr.add_parser('recheck', help='Hear selected existing voice lines with an explicit installed model into fresh evidence')
    recheck.add_argument('voice_dir')
    recheck.add_argument('--model', required=True)
    recheck.add_argument('--line', action='append', required=True)
    recheck.add_argument('--lang', default='en')
    recheck.add_argument('-o', '--output', required=True)
    return parser


def model_readiness(engine, name):
    """Compose declared model/component readers; readiness is not model-load proof."""
    from st import lazy
    from st.footage import transcribe
    if engine not in lazy.ASR_COMPONENTS:
        return {'state': 'unsupported', 'reason': 'No adopted ASR component declaration for this engine'}
    try:
        marker = transcribe._installed(engine, name)
        manifest = lazy.manifest()
        pips = manifest.get('lazy_pip', {})
        components = [{'id': component, 'kind': 'python' if component in pips else 'model',
                       'ready': lazy.pip_ready(component, manifest) if component in pips else lazy.item_ready(component)}
                      for component in lazy.asr_components(engine, name)]
        ready = bool(marker and components and all(row['ready'] for row in components))
        return {'state': 'ready_candidate' if ready else 'unavailable',
                'model_marker_installed': marker, 'components': components,
                'scope': 'Declared local model markers/components only; actual recognition can still fail'}
    except Exception as error:
        return {'state': 'unknown', 'reason': str(error)}


def inspect_asr(lang):
    from st.footage import transcribe
    from st.voice import readback
    primary = transcribe.choose_model('auto', lang)
    grouped = {}
    unresolved = []
    for alias in transcribe.MODELS:
        try:
            engine, name = transcribe.choose_model(alias, lang)
            grouped.setdefault((engine, name), []).append(alias)
        except Exception as error:
            unresolved.append({'alias': alias, 'state': 'ineligible_or_unknown', 'reason': str(error)})
    models = [{'engine': engine, 'name': name, 'aliases': aliases,
               'same_as_current_primary': (engine, name) == primary,
               **model_readiness(engine, name)} for (engine, name), aliases in grouped.items()]
    return {'schema': 'local-asr-readiness/v1', 'language': lang,
            'primary_resolution': {'engine': primary[0], 'name': primary[1]},
            'owner_selected_alternate': readback.second_recognizer(lang), 'models': models,
            'unresolved_declarations': unresolved,
            'model_loading': False, 'downloads': False,
            'scope': 'Finite declared model/component inspection, not a home/cache scan or recognition qualification'}


def _fingerprint(path):
    from st.content_hash import content_hash
    return '1f:' + content_hash(path.read_bytes()).hexdigest()


def recheck_lines(voice_dir, model, line_ids, output, lang='en'):
    from st.common import ShowtimeError
    from st.footage import transcribe
    if model not in transcribe.MODELS:
        raise ShowtimeError('Recheck needs an explicit model alias from the adopted ASR declaration.')
    engine, name = transcribe.choose_model(model, lang)
    readiness = model_readiness(engine, name)
    if readiness['state'] != 'ready_candidate':
        raise ShowtimeError('The requested local recognizer is not ready: ' + json.dumps(readiness))
    source = Path(voice_dir).resolve()
    timeline_path = source / 'timeline.json'
    timeline = json.loads(timeline_path.read_text())
    if not line_ids or len(line_ids) != len(set(line_ids)):
        raise ShowtimeError('Choose unique existing line ids.')
    lines = timeline.get('lines', [])
    if len({line['id'] for line in lines}) != len(lines):
        raise ShowtimeError('The source timeline has duplicate line ids.')
    selected = [line for line in lines if line['id'] in line_ids]
    if len(selected) != len(line_ids):
        raise ShowtimeError('A requested line id is absent from the source timeline.')
    inputs = [timeline_path]
    for key in ('file',):
        name_in_timeline = timeline.get(key)
        if name_in_timeline:
            candidate = (source / name_in_timeline).resolve()
            if not candidate.is_relative_to(source):
                raise ShowtimeError('A timeline source leaves its voice directory.')
            inputs.append(candidate)
    primary_readback = (timeline.get('readback') or {}).get('file')
    if primary_readback:
        candidate = (source / primary_readback).resolve()
        if not candidate.is_relative_to(source):
            raise ShowtimeError('The original readback leaves its voice directory.')
        inputs.append(candidate)
    clips = {}
    for line in selected:
        clip = (source / line['file']).resolve()
        if not clip.is_relative_to(source):
            raise ShowtimeError('A selected line leaves its voice directory.')
        inputs.append(clip)
        clips[line['id']] = clip
    pins = [{'path': str(path), 'blake3': _fingerprint(path)} for path in dict.fromkeys(inputs)]
    out = Path(output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    (out / 'transcripts').mkdir()
    binding = {'schema': 'selected-voice-asr-binding/v1', 'source': str(source),
               'model_alias': model, 'engine': engine, 'model_name': name,
               'line_ids': [line['id'] for line in selected], 'sources': pins,
               'readiness': readiness, 'state': 'prepared'}
    binding_path = out / 'source-binding.json'
    binding_path.write_text(json.dumps(binding, indent=2) + '\n')
    results = []
    try:
        for line in selected:
            if any(_fingerprint(Path(row['path'])) != row['blake3'] for row in pins):
                raise ShowtimeError('A bound source changed before recognition; use a fresh output epoch.')
            transcript, _ = transcribe.transcribe(clips[line['id']], model=model, language=lang,
                events='off', refine=False, gap_scan=False, separate='off', use_stem=False,
                prompt='', force=True, edit_dir=out / 'transcripts',
                out_path=out / 'transcripts' / (str(line['index']).zfill(2) + '.json'))
            results.append({'id': line['id'], 'source_text': line['text'], 'heard': transcript['text'],
                            'words': [word for word in transcript['words'] if word.get('type') == 'word'],
                            'actual_model': transcript['model'], 'actual_engine': transcript['engine'],
                            'guards': transcript.get('guards')})
        if any(_fingerprint(Path(row['path'])) != row['blake3'] for row in pins):
            raise ShowtimeError('A bound source changed during recognition; outputs remain unqualified.')
    except Exception as error:
        binding.update(state='recognition_failed', error=str(error))
        binding_path.write_text(json.dumps(binding, indent=2) + '\n')
        raise
    report = {'schema': 'selected-voice-asr-recheck/v1', 'model_alias': model,
              'engine': engine, 'model_name': name, 'lines': results,
              'source_inputs_unchanged': True, 'forced_fresh_recognition': True,
              'source_script_supplied_to_recognizer': False,
              'scope': 'Alternate local recognition only; no waveform/script changes, human listening or acoustic correctness verdict'}
    (out / 'recognition.json').write_text(json.dumps(report, indent=2) + '\n')
    binding.update(state='recognized_bound')
    binding_path.write_text(json.dumps(binding, indent=2) + '\n')
    return report


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == 'asr':
        result = inspect_asr(args.lang) if args.operation == 'inspect' else recheck_lines(
            args.voice_dir, args.model, args.line, args.output, args.lang)
        print(json.dumps(result))
        return
    data = json.loads(Path(args.input).read_text())
    place = data.get('place')
    if place is not None and (not isinstance(place, str) or not place.strip()):
        parser.error('place must name a nonempty existing speaker context.')
    os.environ.pop('TRILLION_NARRATION_PLACE', None)
    if place is not None:
        os.environ['TRILLION_NARRATION_PLACE'] = place
    from st.voice import script
    timeline = script.build(args.input, args.output, readback=True)
    module_sources = {name: str(Path(module.__file__).resolve()) for name, module in sys.modules.items()
                      if (name == 'st' or name.startswith('st.')) and getattr(module, '__file__', None)}
    if any(not Path(path).is_relative_to(ROOT / 'lib') for path in module_sources.values()):
        raise RuntimeError('Narration imported source outside its adopted library owner.')
    (Path(args.output) / 'runtime-source-readback.json').write_text(json.dumps({
        'interpreter': sys.executable, 'source_root': str(ROOT), 'modules': module_sources,
        'speaker_bridge': str(ROOT / 'speak.mjs'), 'place': place,
        'scope': 'Imported Python source paths observed after production; this is not an interval source-byte identity proof.'
    }, indent=2) + '\n')
    print(json.dumps({'duration': timeline['duration'], 'lines': len(timeline['lines']), 'readback': timeline.get('readback')}))


if __name__ == '__main__':
    main()
