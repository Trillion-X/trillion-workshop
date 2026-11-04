"""Read installed narration dependencies; never install or load setup source.

Adapted from Showtime's MIT-licensed readiness contract. The source-owned
consumer uses existing local runtime assets and refuses absent dependencies.
"""
import importlib.util
import json
from .common import ShowtimeError, home, paths
from . import platform as plat

ASR_COMPONENTS = {
    'whisper': {'small.en': ('whisper-engine', 'whisper-small.en'),
                'large-v3-turbo': ('whisper-engine', 'whisper-large-v3-turbo'),
                '*': ('whisper-engine',)},
    'parakeet': {'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8': ('parakeet-tdt-0.6b-v2-int8',),
                 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8': ('parakeet-tdt-0.6b-v3-int8',)},
}

def manifest():
    return json.loads((paths()['setup'] / 'manifest.json').read_text())

def offline():
    return True

def asr_components(engine, model):
    table = ASR_COMPONENTS.get(engine, {})
    return table.get(model) or table.get('*') or ()

def pip_ready(cid, man=None):
    spec = ((man or manifest()).get('lazy_pip') or {}).get(cid)
    return bool(spec and importlib.util.find_spec(spec['import']))

def _item(cid):
    return next((item for item in manifest().get('items', []) if item['id'] == cid), None)

def _files(item):
    files = (item or {}).get('files', [])
    return files.get(plat.platform_key(), []) if isinstance(files, dict) else files

def _location(file):
    return home() / (file.get('creates') or file['dest'])

def item_ready(cid):
    files = _files(_item(cid))
    return bool(files and all(_location(file).exists() for file in files))

def ensure_item(cid, feature, allow_download=False):
    if not item_ready(cid):
        raise ShowtimeError('%s needs installed local component %s; this producer cannot install it.' % (feature, cid))
    return _location(_files(_item(cid))[0])

def ensure_pip(cid, feature, allow_download=False):
    if not pip_ready(cid):
        raise ShowtimeError('%s needs installed local Python component %s; this producer cannot install it.' % (feature, cid))

def ensure_asr(engine, model, feature='transcription'):
    man = manifest()
    for cid in asr_components(engine, model):
        if cid in man.get('lazy_pip', {}):
            ensure_pip(cid, feature)
        else:
            ensure_item(cid, feature)
