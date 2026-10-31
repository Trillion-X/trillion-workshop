"""Per-check pins: the identity of what one check is made of, so a change to one check voids only that check's recorded answers.
A check's pin is the BLAKE3 of the config sections it reads (CHECK_SECTIONS) plus the source of its own module plus the shared code every check
runs on (SHARED_FILES, SHARED_SECTIONS). A person who records verdicts on a check's findings keeps the pin beside them and knows from it when that check changed.
test/test_checks.py PinScope checks that every `cfg[...]` section a check module reads is listed here, so a check cannot read a section its
pin does not cover."""
import json
import os

from . import config

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED_SECTIONS = ('frame', 'analysis')       # read by ctx.py or by most checks; a change voids every check
SHARED_FILES = ('ctx.py', 'media.py', 'jsonio.py', 'report.py')
# check name (as the command line and the report name it): (module file, config sections beyond the shared ones[, helper modules the check imports])
CHECK_SECTIONS = {
    'in-frame': ('in_frame', ('in_frame',)),
    'joins': ('joins', ('joins', 'word_clip')),
    'word-clip': ('word_clip', ('word_clip',)),
    'jitter': ('jitter', ('jitter',)),
    'text': ('text', ('text',)),
    'face': ('face', ('face', 'settle', 'in_frame', 'dwell', 'movement'), ('checks/settle.py', 'checks/dwell.py', 'checks/in_frame.py')),
    'exits': ('exits', ('exits', 'in_frame')),
    'dwell': ('dwell', ('dwell', 'in_frame', 'word_clip')),
    'type-sync': ('type_sync', ('type_sync',)),
    'backing': ('backing', ('backing',)),
    'movement': ('movement', ('movement',)),
    'sound-harsh': ('sound_harsh', ('sound_harsh', 'sound_mix'), ('sfx.py',)),
    'sound-balance': ('sound_balance', ('sound_balance', 'sound_mix'), ('sfx.py',)),
    'settle': ('settle', ('settle', 'in_frame', 'dwell', 'movement'), ('checks/dwell.py',)),
    'internal-text': ('internal_text', ('internal_text', 'dwell'), ('checks/dwell.py',)),
    'text-size': ('text_size', ('text_size',)),
    'tempo': ('tempo', ('tempo', 'in_frame', 'dwell'), ('checks/dwell.py', 'checks/settle.py')),
    'zoom': ('zoom', ('zoom',)),
    'placement': ('placement', ('placement',)),
    'info-added': ('info_added', ('info_added', 'dwell'), ('checks/dwell.py',)),
    'motion-blur': ('motion_blur', ('motion_blur',)),
    'sound-sync': ('sound_sync', ('sound_sync',), ('sfx.py',)),
    'camera': ('camera', ('camera',)),
    'math-shown': ('math_shown', ('math_shown', 'dwell'), ('checks/dwell.py',)),
    'cue': ('cue', ('cue',)),
    'broll': ('broll', ('broll', 'face'), ('checks/dwell.py',)),
    'filler-words-cut': ('filler_words', ('filler_words',)),
    'sound-loops': ('sound_loops', ('sound_loops',), ('sfx.py',)),
}


def _read(rel):
    with open(os.path.join(HERE, rel), 'rb') as f:
        return f.read().decode('utf-8')


def check_pins(cfg):
    """{check name: BLAKE3 hex} for every check, from the given (already merged) config and the code on disk."""
    shared_code = {f: _read(f) for f in SHARED_FILES}
    out = {}
    for name, (module, sections, *helpers) in CHECK_SECTIONS.items():
        body = {'sections': {s: cfg.get(s) for s in sorted(set(SHARED_SECTIONS) | set(sections))}, 'code': _read(f'checks/{module}.py'), 'shared_code': shared_code}
        if helpers:      # a check built on helper modules (sfx.py, ...) is voided by a change to them; checks without helpers keep their earlier pins
            body['helpers'] = {h: _read(h) for h in helpers[0]}
        out[name] = config.blake3_hex(json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())
    return out
