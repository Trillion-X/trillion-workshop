"""A made-up bakery library for the checklist gate tests: a checklist text, a rule source, a schema that maps the bakery's layout onto the gate's
words, small tools standing in for a checker and a gate, and batches (pieces) of loaves (items). Nothing here belongs to a real person."""
from __future__ import annotations

import json
from pathlib import Path

CHECKLIST_SOURCE = """# Bakery checklist

**Delivery stages:** review = a loaf shown to the baker for a pick; final = a loaf put on the shelf. A gate run names its stage; a run that names none is final.

## B1. Bake
**Inputs:** flour; water
**Produces:** loaves
| B1.1 | [ ] Oven is preheated | all | Read the thermometer | habit | yes |
| B1.R1 | [ ] No raw egg on the tray | bread | Look at the tray | rule | yes | no-raw-egg |
| B1.R2 | [ ] Slash pattern is even | bread | Look at the loaf | rule | no | even-slash |
| B1.R3 | [ ] Mixer hum is steady | audio | Listen to the take | rule | yes | steady-hum |
| B1.G1 | [ ] Loaf weight is in range | bread | Run the scale gate | gate | yes | weigh-gate |
| B1.Q1 | [ ] Crust colour is in range | bread | Run the taste check on crust | measure | yes | crust-colour |
| B1.Q2 | [ ] Crumb is open | bread | Run the taste check on crumb | measure | yes | crumb-open |
| B1.Q3 | [ ] Crumb finding no rule names | bread | Run the taste check on crumb | measure | yes | crumb-other |
| B1.Q4 | [ ] The whole batch was swept | bread | Run the sweep | measure | yes | sweep-rule |
**Agent rule:** B1.Q3 (agent-sourced). The oven crew never wrote this one down.
**Advisory row:** B1.G1 at review. A loaf slightly off weight may still be shown to the baker.

## B2. Sell
**Inputs:** loaves
**Produces:** sales
| B2.1 | [ ] Allergen label is on the tray | nuts | Read the label | habit | yes |
| B2.2 | [ ] Sold out by close | all | Count the shelf | habit | no |
| B2.3 | [ ] Reviews read next week | all | Read them | habit | no |

**Rule source:** `rules.json` (the rows whose kinds include bakery)

## Notes
"""

CHECKLIST_HEADER = {
    'note': 'Generated from checklist-source.md; regenerate after editing it.',
    'publish_phase': ['B2.2'],
    'after_phase': ['B2.3 (next week)'],
}

RULES = {'rows': [
    {'id': 'no-raw-egg', 'rule': 'No raw egg is ever left on a tray.', 'kinds': ['bakery']},
    {'id': 'even-slash', 'rule': 'Slashes run the same way and depth.', 'kinds': ['bakery']},
    {'id': 'steady-hum', 'rule': 'The mixer hums at one pitch.', 'kinds': ['bakery']},
    {'id': 'not-a-bakery-rule', 'rule': 'Belongs to another kind.', 'kinds': ['other']},
]}

SCHEMA = {
    'checklist': 'checklist.json',
    'lock': 'data/.gate.lock',
    'piece': {
        'header': {'file': 'BATCH.md', 'heading': 'Batch header', 'tag_fields': ['medium', 'source', 'flags'], 'implied_tags': {'sourdough': ['bread'], 'data:*': ['data']}},
        'answers_file': 'answers.jsonl',
        'record_file': 'record.json',
        'on_first_gate': {'command': ['{python}', '-I', '{library}/tools/start_record.py', '{piece}'], 'written_key': 'written'},
        'config': {
            'file': 'batch.json',
            'defaults': {'item_globs': ['lane-*/previews-round-*/*.txt', 'lane-*/previews-round-*/*.wav'], 'spec_globs': ['specs-round-*/{name}.json'],
                         'verdict_file': 'verdicts.jsonl', 'picked_verdicts': ['picked']},
            'defaults_when_parent': 'batches',
            'keys': {'item_globs': 'item_globs', 'spec_globs': 'spec_globs', 'id_mode': 'id_mode', 'verdict_file': 'verdict_file', 'picked_verdicts': 'picked_verdicts',
                     'gate_words': 'gate_words'},
        },
    },
    'answers': {'words': {'pass': 'passed', 'fail': 'failed', 'n/a': 'n.a.'}, 'min_evidence_chars': 12},
    'items': {
        'not_items_pattern': '(?i)(^|/)(scratch[^/]*|held-back[^/]*|ROUND \\d+ watch-these)',
        'compilation_pattern': '^_ALL',
        'file_media': {'audio': ['wav']},
        'file_pin_cache': '.local/pins',
        'watch_folder_pattern': '(?i)watch-these',
        'spec_globs': ['specs-round-*/{name}.json'],
        'report_globs': ['checker-*.json'],
        'judgment_rules': ['no-raw-egg'],
        'watch_round_pattern': '(?i)ROUND (\\d+) ',
        'watch_suffixes': ['.txt'],
        'held_folder': 'held-back',
        'lane_up': 2,
        'lane_dir_pattern': '^lane-',
        'round_dir_pattern': 'previews-round-(\\d+)',
        'moments': {'patterns': [{'pattern': '^(m\\d+)-r(\\d+)$', 'moment_group': 1, 'round_group': 2}, {'pattern': '^(m\\d+)$', 'moment_group': 1, 'round': 1}], 'aliases': {}},
        'rebuild': {'spec_glob': 'lane-*/specs-round-*/{option}.json', 'key': 'rebuild_of'},
        'ruling_waits': {'rules': ['no-raw-egg'], 'uncertain_word': 'UNCERTAIN', 'fail_word': 'FAIL'},
        'proven_flags': [{'flag': 'nuts', 'source': 'spec', 'paths': ['recipe.nuts']}],
    },
    'checkers': {
        'answerer': 'taste-checker',
        'label': 'taste-check',
        'report_meta_key': '_taste',
        'report_checks': {'crust': ['crust-colour'], 'crumb': [{'rule': 'crumb-open', 'finding_match': '^open'}]},
        'report_unmapped_rule': {'crumb': 'crumb-other'},
        'report_unmapped_count': {'pattern': '(\\d+) slice', 'what': 'slices'},
        'report_pins': {'$ref': {'file': 'reviewed-pins.json', 'path': 'pins'}},
        'reviewed_pins_where': 'reviewed-pins.json',
        'not_measured_blip_s': 1,
        'current_pins_command': ['python3', '-I', '{library}/tools/checker_pins.py'],
        'sweep': {
            'by': 'sweeper', 'rule': 'sweep-rule', 'pin': 'sweep-pin-1', 'item_glob': '*.txt', 'file_prefix': 'sweep', 'review_prefix': 'review', 'stages': ['B1'],
            'batch_command': ['python3', '-I', '{library}/tools/sweep_checker.py', '{folder}', '{specs}', '{out}', '{ids}'],
        },
    },
    'gates': {'weigh-gate': {'by': 'scale', 'pin_files': ['tools/run_gate.py', {'piece_config': 'gate_words', 'default': 'tools/gate-words.txt'}]}},
    'runs': {
        'lane': {'command': ['{python}', '-I', '{library}/tools/run_gate.py', 'lane', '{lane}', '{item}', '{stage}'], 'gates': ['weigh-gate'], 'item_glob': 'previews-round-*/*.txt',
                 'evidence_chars': 80, 'advisory_passes': True},
        'files': {'command': ['{python}', '-I', '{library}/tools/run_gate.py', 'file', '{file}', '{item}', '{stage}'], 'gates': ['weigh-gate'], 'evidence_chars': 80},
    },
    'audit': {'stages': ['B1'], 'at': 'review'},
    'checklist_source': {
        'file': 'checklist-source.md',
        'header': CHECKLIST_HEADER,
        'stage': {'pattern': '^## (B\\d+)\\. (.+?)\\n(.*?)(?=^## )', 'fields': {'inputs': 'Inputs', 'outputs': 'Produces'}},
        'delivery': {'pattern': '^\\*\\*Delivery stages:\\*\\* (.+)$', 'default': 'final'},
        'rule_source': {'pattern': '\\*\\*Rule source:\\*\\* `([^`]+)`', 'rows_path': 'rows', 'id_field': 'id', 'rule_field': 'rule', 'kinds_field': 'kinds', 'kind': 'bakery'},
        'row_kinds': [
            {'pattern': '^\\| (B\\d+\\.\\d+) \\| \\[ \\] (.+?) \\| (.+?) \\| (.+?) \\| (.+?) \\| (yes|no) \\|$', 'fields': ['id', 'check', 'routes', 'verify', 'kind', 'must']},
            {'pattern': '^\\| (B\\d+\\.R\\d+) \\| \\[ \\] (.+?) \\| (.+?) \\| (.+?) \\| (.+?) \\| (yes|no) \\| ([a-z0-9-]+) \\|$',
             'fields': ['id', 'check', 'routes', 'verify', 'kind', 'must', 'rule_id'], 'covers_rule_source': True,
             'adds': [['per_option', True], ['rule_id', {'field': 'rule_id'}], ['rule', {'rule_text': 'rule_id'}], ['source', {'source_ref': 'rule_id'}]]},
            {'pattern': '^\\| (B\\d+\\.G\\d+) \\| \\[ \\] (.+?) \\| (.+?) \\| (.+?) \\| (.+?) \\| (yes|no) \\| ([a-z0-9-]+) \\|$',
             'fields': ['id', 'check', 'routes', 'verify', 'kind', 'must', 'rule_id'],
             'adds': [['per_option', True], ['rule_id', {'field': 'rule_id'}], ['gate_run', {'field': 'rule_id'}], ['rule', {'field': 'check'}]]},
            {'pattern': '^\\| (B\\d+\\.Q\\d+) \\| \\[ \\] (.+?) \\| (.+?) \\| (.+?) \\| (.+?) \\| (yes|no) \\| ([a-z0-9-]+) \\|$',
             'fields': ['id', 'check', 'routes', 'verify', 'kind', 'must', 'rule_id'],
             'adds': [['per_option', True], ['rule_id', {'field': 'rule_id'}], ['checker_only', True], ['rule', {'field': 'check'}]]},
        ],
        'notes': [
            {'pattern': '^\\*\\*Agent rule:\\*\\* (B\\d+\\.Q\\d+) \\(agent-sourced\\)\\. (.+)$', 'target_flag': 'checker_only', 'set': [['source', 'agent'], ['agent_why', {'group': 2}]],
             'refusal': 'Agent rule {id}: no such Q row in {stage}'},
            {'pattern': '^\\*\\*Advisory row:\\*\\* (B\\d+\\.\\w+) at ([a-z, ]+?)\\. (.+)$', 'stages_group': 2, 'set': [['advisory_passes_at', {'group': 2, 'split': True}], ['advisory_why', {'group': 3}]],
             'refusal': 'Advisory row {id} at {stages}: no such check in {stage}, or a stage not in "Delivery stages" {known}'},
        ],
    },
}

TOOLS = {
    'start_record.py': """import json
import sys
from pathlib import Path

piece = Path(sys.argv[1])
(piece / 'record.json').write_text('{}', encoding='utf-8')
print(json.dumps({'written': 'record.json'}))
""",
    'checker_pins.py': """import json

print(json.dumps({'crust': 'p-crust-1', 'crumb': 'p-crumb-1'}))
""",
    'run_gate.py': """import json
import sys
from pathlib import Path

mode, where, item, stage = sys.argv[1:5]
text = ''
if mode == 'lane':
    found = sorted(Path(where).glob(f'previews-round-*/{item}.txt'))
    text = found[-1].read_text() if found else ''
else:
    text = Path(where).read_text() if Path(where).suffix == '.txt' else ''
if 'NOSPEC' in text:
    print(json.dumps({'problem': f'no spec for {item}'}))
elif 'NOMEASURE' in text:
    print(json.dumps({'not_measured': f'{item} has no weight on it'}))
else:
    answer = 'fail' if 'OVERWEIGHT' in text else 'advisory' if 'SOFT' in text else 'pass'
    print('noise before the result line')
    print(json.dumps({'rows': [{'gate': 'weigh-gate', 'answer': answer, 'evidence': f'scale read {item} at stage {stage}: {answer}'}]}))
""",
    'sweep_checker.py': """import json
import os
import sys
from pathlib import Path

folder, specs, out, ids = sys.argv[1:5]
report = {'_taste': {'check_pins': {'crust': 'p-crust-1', 'crumb': 'p-crumb-1'}, 'config_overridden': False}}
for name in ids.split(','):
    path = Path(folder) / f'{name}.txt'
    text = path.read_text()
    crust = [{'status': 'FAIL', 'message': 'crust is burnt'}] if 'BURNT' in text else [{'status': 'PASS', 'message': 'crust ok'}]
    crumb = [{'status': 'PASS', 'message': '4 slices cut, all fine'}]
    if 'CLOSED' in text:
        crumb = [{'status': 'FAIL', 'message': 'open crumb missing'}]
    if 'DENSE' in text:
        crumb = [{'status': 'FAIL', 'message': 'dense at slice 3'}]
    report[os.path.realpath(path)] = {'crust': crust, 'crumb': crumb}
Path(out).write_text(json.dumps(report), encoding='utf-8')
""",
}


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return path


def header(piece: Path, medium: str = 'bread', flags: str = '') -> None:
    write(piece / 'BATCH.md', f'# {piece.name}\n\n## Batch header\n\n```\nmedium: {medium}\nsource: own\nflags: {flags}\n```\n')


def loaf(piece: Path, lane: str, round_number: int, name: str, text: str = 'plain loaf', suffix: str = 'txt', spec: dict | None = None) -> Path:
    path = write(piece / lane / f'previews-round-{round_number}' / f'{name}.{suffix}', text)
    if spec is not None:
        write(piece / lane / f'specs-round-{round_number}' / f'{name}.json', json.dumps(spec))
    return path


def build(root: Path) -> tuple[Path, Path]:
    """The library folder and its schema file, with one batch, `monday`, holding loaves m1-r1 (round 1), m1-r2 and m2 (round 2). The checklist file is generated by the test."""
    write(root / 'schema.json', json.dumps(SCHEMA))
    write(root / 'checklist-source.md', CHECKLIST_SOURCE)
    write(root / 'rules.json', json.dumps(RULES))
    write(root / 'reviewed-pins.json', json.dumps({'pins': {'crust': 'p-crust-1', 'crumb': 'p-crumb-1'}}))
    for name, text in TOOLS.items():
        write(root / 'tools' / name, text)
    write(root / 'tools' / 'gate-words.txt', 'light; heavy\n')
    piece = root / 'batches' / 'monday'
    header(piece)
    loaf(piece, 'lane-a', 1, 'm1-r1', spec={'recipe': {}})
    loaf(piece, 'lane-a', 2, 'm1-r2', spec={'recipe': {}})
    loaf(piece, 'lane-a', 2, 'm2', spec={'recipe': {}})
    return root, root / 'schema.json'
