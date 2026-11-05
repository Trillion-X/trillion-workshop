"""A made-up world, sources and shots for the claim-check tests. Nobody here is real: Mara cooks cheap meals on camera,
Pip is the narrator who comments on her, Sam is her friend. `build(folder)` writes every file and returns the request.
"""
import json
import os

STRENGTH = {
    'scope': {'3': ['the most', 'at most', 'no more than', 'at least', 'all', 'every', 'always', 'never', 'none', 'nothing',
                    'only', 'cannot', "can't", 'must', 'has to', 'have to', 'no one', 'nobody'],
              '2': ['most', 'almost all', 'nearly all', 'usually', 'mostly', 'generally'],
              '1': ['many', 'some', 'up to', 'often', 'can', 'may', 'might', 'typically', 'sometimes', 'several']},
    'certainty': {'3': ['confident', 'certain', 'sure', 'knows', 'definitely', 'proves', 'proven', 'guaranteed'],
                  '2': ['expects', 'believes', 'likely', 'probably'],
                  '1': ['guess', 'guessing', 'thinks', 'think', 'hopes', 'maybe', 'perhaps', 'wonders', 'reckons']}}
QUALIFIERS = {'': {'rel': 0.005, 'or_rounds_to_integer': True}, 'about': {'rel': 0.1}, 'around': {'rel': 0.1},
              'nearly': {'rel': 0.1, 'side': 'below'}, 'almost': {'rel': 0.1, 'side': 'below'},
              'over': {'side': 'above', 'bound': True}, 'more than': {'side': 'above', 'bound': True},
              'under': {'side': 'below', 'bound': True}, 'less than': {'side': 'below', 'bound': True},
              'at most': {'side': 'below_or_equal', 'bound': True}, 'up to': {'side': 'below_or_equal', 'bound': True},
              'at least': {'side': 'above_or_equal', 'bound': True}}
RULES = {
    'strength': STRENGTH, 'qualifiers': QUALIFIERS,
    'subject_words': ['mara', 'she', "she's", 'her', 'hers', 'herself'],
    'no_claim': {'imperative_verbs': ['tell', 'comment', 'subscribe', 'watch']},
    'support_said_by_not': ['pip'],
    'labels': ['narrated by Pip'],
    'accounting_skips': ['mara', 'pip', 'ep-1'],
    'auto_topic_kinds': ['item'],
    'bind_from_level': 2,
    'fillers': ['uh', 'um'],
    'tense_markers': {'past': ['was', 'were', 'did', 'had', 'used to', 'made', 'said', 'took', 'before', 'once'],
                      'plan': ['next', 'will', "'ll", 'going to', 'plans', 'next time']},
    'claim_fact_kinds': ['claim'],
    'claim_said_by': ['mara'],
    'compounds': [{'phrase': 'lentil soup', 'entity': 'lentil-soup', 'tags': ['lentil soup', 'soup']}],
    'quantity_units': {'tablet': ['tablet', 'tablets', 'pill', 'pills'], 'serving': ['serving', 'servings'],
                       'pot': ['pot', 'pots'], 'batch': ['batch', 'batches']},
    'same_quantity_unit': [{'units': ['pot', 'batch'], 'why': 'her one batch fills the one pot'}],
    'unit_clause_breaks': ['than', 'which', 'but', 'while', 'because', 'so', 'and', 'or'],
}
SETTINGS = {'rules': RULES, 'subject_name': 'Mara', 'narrator_name': 'Pip', 'hedge_row': 'check row no-hedge-or-attribution'}


def setting_row(settings=None, tool='tool:check-every-claim-against-its-facts-and-sources', status='active'):
    """The person's list:settings row as records:read gives it: settings as compact JSON text, sorted keys."""
    return {'id': 'record:setting:check-every-claim-against-its-facts-and-sources~film~sample-film', 'type': 'record:setting',
            'value': {'name': 'claim rules of a made-up film', 'tool': tool, 'scope_kind': 'film', 'scope_id': 'sample-film',
                      'settings': json.dumps(SETTINGS if settings is None else settings, sort_keys=True, separators=(',', ':')),
                      'from': 'made up', 'status': status}}
HEDGES = ['she reports', 'reports:', 'her estimate', 'estimate', 'not yet tested', 'reportedly']

FIELDS = {
    'world-kinds': [('label', 'text'), ('applies_to', 'choice', ['entity', 'fact', 'relation']), ('about', 'text')],
    'world-entities': [('name', 'text'), ('kind', 'link', 'world-kinds'), ('aliases', 'tags'), ('sequence', 'number')],
    'world-facts': [('statement', 'text'), ('about', 'link', 'world-entities'), ('fact_kind', 'link', 'world-kinds'),
                    ('said', 'text'), ('said_by', 'link', 'world-entities'), ('episode', 'link', 'world-entities'),
                    ('source', 'text'), ('source_at_s', 'number'), ('source_line', 'number'), ('topics', 'tags'),
                    ('tense', 'choice', ['current', 'past', 'plan', 'belief', 'question']), ('as_of', 'text'),
                    ('conflicts_with', 'link', 'world-facts'), ('private', 'choice', ['yes'])],
}
TITLE = {'world-kinds': 'label', 'world-entities': 'name', 'world-facts': 'statement'}
ROW_TYPE = {'world-kinds': 'world-kind', 'world-entities': 'world-entity', 'world-facts': 'world-fact'}

KINDS = {'person': ('Person', 'entity'), 'character': ('Character', 'entity'), 'topic': ('Topic', 'entity'),
         'item': ('Item', 'entity'), 'episode': ('Episode', 'entity'), 'fact': ('Fact', 'fact'),
         'claim': ('Claim', 'fact'), 'friend': ('friend', 'relation')}
ENTITIES = {
    'mara': {'name': 'Mara Example', 'kind': ['person'], 'aliases': ['Mara']},
    'pip': {'name': 'Pip', 'kind': ['character']},
    'sam': {'name': 'Sam Sample', 'kind': ['person'], 'aliases': ['Sam']},
    'mission': {'name': 'her mission', 'kind': ['topic']},
    'iron': {'name': 'iron', 'kind': ['topic']},
    'lentils': {'name': 'lentils', 'kind': ['item'], 'aliases': ['lentil']},
    'lentil-soup': {'name': 'lentil soup', 'kind': ['item']},
    'ep-1': {'name': 'Episode one', 'kind': ['episode'], 'sequence': 1},
}
TRANSCRIPT = {'words': [
    {'text': 'Hi,', 'start': 0.5, 'end': 0.8}, {'text': 'my', 'start': 2.0, 'end': 2.1}, {'text': 'mission', 'start': 2.1, 'end': 2.5},
    {'text': 'is', 'start': 2.5, 'end': 2.6}, {'text': 'the', 'start': 2.6, 'end': 2.7}, {'text': 'cheapest', 'start': 2.7, 'end': 3.1},
    {'text': 'balanced', 'start': 3.1, 'end': 3.5}, {'text': 'meals', 'start': 3.5, 'end': 3.8}, {'text': 'in', 'start': 3.8, 'end': 3.9},
    {'text': 'town.', 'start': 3.9, 'end': 4.2}, {'text': 'Lentils', 'start': 6.0, 'end': 6.4}, {'text': 'are', 'start': 6.4, 'end': 6.5},
    {'text': 'cheap.', 'start': 6.5, 'end': 6.9}]}
NOTES = ['cheapest balanced meals',
         'I take 18 mg of iron, one serving a day',
         'Lentils are the best food there is',
         'I used to take 10 mg of iron',
         'Sam cooks with me on Sundays',
         'one pot of lentil soup has 54 g of protein',
         'Pip says lentils are fine']
FACTS = {
    'f-mission-claim': {'statement': 'Mara states her mission as the cheapest balanced meals in town.', 'about': ['mission', 'mara'],
                        'fact_kind': ['claim'], 'said': 'my mission is the cheapest balanced meals in town.', 'said_by': ['mara'],
                        'episode': ['ep-1'], 'source': 'take-1.words.json', 'source_at_s': 2.0},
    'f-mission-hook': {'statement': 'Her hook wording.', 'about': ['mission'], 'fact_kind': ['fact'], 'said': NOTES[0],
                       'said_by': ['mara'], 'source': 'notes.txt', 'source_line': 1},
    'f-iron-dose': {'statement': 'Mara takes 18 mg of iron a day, one serving a day.', 'about': ['iron', 'mara'], 'fact_kind': ['fact'],
                    'said': NOTES[1], 'said_by': ['mara'], 'source': 'notes.txt', 'source_line': 2, 'tense': 'current'},
    'f-lentils-belief': {'statement': 'She thinks lentils are the best food.', 'about': ['lentils'], 'fact_kind': ['fact'],
                         'said': NOTES[2], 'said_by': ['mara'], 'source': 'notes.txt', 'source_line': 3, 'tense': 'belief'},
    'f-iron-past': {'statement': 'She used to take 10 mg of iron a day.', 'about': ['iron'], 'fact_kind': ['fact'], 'said': NOTES[3],
                    'said_by': ['mara'], 'source': 'notes.txt', 'source_line': 4, 'tense': 'past'},
    'f-friend': {'statement': 'Sam cooks with Mara on Sundays.', 'about': ['sam'], 'fact_kind': ['fact'], 'said': NOTES[4],
                 'said_by': ['mara'], 'source': 'notes.txt', 'source_line': 5},
    'f-soup-protein': {'statement': 'One pot of her lentil soup has 54 g of protein.', 'about': ['lentil-soup'], 'fact_kind': ['fact'],
                       'said': NOTES[5], 'said_by': ['mara'], 'source': 'notes.txt', 'source_line': 6},
    'f-pip-note': {'statement': 'Pip says lentils are fine.', 'about': ['pip', 'lentils'], 'fact_kind': ['fact'], 'said': NOTES[6],
                   'said_by': ['pip'], 'source': 'notes.txt', 'source_line': 7},
}
RELATIONS = [{'subject': 'record:world-entity:sam', 'role': 'friend', 'object': 'record:world-entity:mara',
              'said': 'fact:f-friend Sam cooks with me on Sundays'}]
SOURCE_TEXT = 'Iron, Fact Sheet (made up). Adults 19-50 years 18 mg a day. Spinach, 1 cup cooked 6 mg. Lentils, 1 cup cooked 6.6 mg.'

SHOTS = {
    'own-claim-plain': ['My mission is the cheapest balanced meals in town.',
                        [{'words': 'My mission is the cheapest balanced meals in town.', 'kind': 'claim', 'facts': ['f-mission-claim'],
                          'considered': {'f-mission-hook': 'her hook wording, which this line does not repeat'}}]],
    'attributed-hedge': ['Mara reports: the cheapest balanced meals in town, by her estimate.',
                         [{'words': 'Mara reports: the cheapest balanced meals in town, by her estimate.', 'kind': 'claim',
                           'facts': ['f-mission-claim'], 'considered': {'f-mission-hook': 'her hook wording'}}]],
    'unsupported': ['Lentil soup beats every other meal.', [{'words': 'Lentil soup beats every other meal.', 'kind': 'claim'}]],
    'iron-tablet': ['Her tablet is eighteen milligrams of iron, about three cups of spinach.',
                    [{'words': 'Her tablet is eighteen milligrams of iron, about three cups of spinach.', 'kind': 'claim',
                      'topics': ['iron'], 'facts': ['f-iron-dose'], 'considered': {'f-iron-past': 'an earlier dose'},
                      'sources': [{'source': 'iron-sheet', 'quote': 'Spinach, 1 cup cooked 6 mg.'}],
                      'numbers': [{'spoken': 'eighteen', 'value': 18, 'fact': 'f-iron-dose'},
                                  {'spoken': 'three', 'expr': 'dose / spinach', 'inputs': {
                                      'dose': {'value': 18, 'fact': 'f-iron-dose'}, 'spinach': {'value': 6, 'source': 'iron-sheet'}}}]}]],
    'iron-serving': ['She takes eighteen milligrams of iron a day, about three cups of spinach.',
                     [{'words': 'She takes eighteen milligrams of iron a day, about three cups of spinach.', 'kind': 'claim',
                       'topics': ['iron'], 'facts': ['f-iron-dose'], 'considered': {'f-iron-past': 'an earlier dose'},
                       'sources': [{'source': 'iron-sheet', 'quote': 'Spinach, 1 cup cooked 6 mg.'}],
                       'numbers': [{'spoken': 'eighteen', 'value': 18, 'fact': 'f-iron-dose'},
                                   {'spoken': 'three', 'expr': 'dose / spinach', 'inputs': {
                                       'dose': {'value': 18, 'fact': 'f-iron-dose'}, 'spinach': {'value': 6, 'source': 'iron-sheet'}}}]}]],
}


def lists_json():
    out = []
    for lid, fields in FIELDS.items():
        fs = []
        for f in fields:
            spec = {'id': f[0], 'kind': f[1]}
            if f[1] == 'choice':
                spec['choices'] = f[2]
            if f[1] == 'link':
                spec['links_to'] = f[2]
            fs.append(spec)
        out.append({'list': {'id': lid, 'row_type': ROW_TYPE[lid], 'title_field': TITLE[lid], 'fields': fs}})
    return {'lists': out}


def write(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        if isinstance(value, str):
            f.write(value)
        else:
            json.dump(value, f, indent=1, ensure_ascii=False)


def build(folder, shots=SHOTS):
    world, lane, gate = (os.path.join(folder, n) for n in ('world', 'lane', 'gate'))
    write(os.path.join(world, 'lists.json'), lists_json())
    write(os.path.join(world, 'rows', 'world-kinds.json'),
          {'rows': [{'id': k, 'values': {'label': v[0], 'applies_to': v[1]}} for k, v in KINDS.items()]})
    write(os.path.join(world, 'rows', 'world-entities.json'), {'rows': [{'id': k, 'values': v} for k, v in ENTITIES.items()]})
    write(os.path.join(world, 'rows', 'world-facts.json'), {'rows': [{'id': k, 'values': v} for k, v in FACTS.items()]})
    write(os.path.join(world, 'relations.json'), {'relations': RELATIONS})
    write(os.path.join(world, 'take-1.words.json'), TRANSCRIPT)
    write(os.path.join(world, 'notes.txt'), '\n'.join(NOTES) + '\n')
    write(os.path.join(gate, 'sources.json'), {'sources': {'iron-sheet': {'title': 'made-up iron sheet', 'raw': 'raw/iron.html',
                                                                         'extract': 'html', 'text': 'iron.txt'}}})
    write(os.path.join(gate, 'raw', 'iron.html'), f'<html><head><style>p{{}}</style></head><body><p>{SOURCE_TEXT}</p></body></html>')
    write(os.path.join(gate, 'iron.txt'), SOURCE_TEXT + '\n')
    for sid, (script, voice) in shots.items():
        write(os.path.join(lane, 'shots', f'{sid}.json'), {'id': sid, 'voice': {'script': f'scripts/{sid}.txt'}, 'events': []})
        write(os.path.join(lane, 'scripts', f'{sid}.txt'), script + '\n')
        write(os.path.join(lane, 'claims', f'{sid}.json'), {'voice': voice, 'screen': []})
    return {'shots': sorted(shots), 'lane_dir': lane, 'sources': os.path.join(gate, 'sources.json'), 'frames_root': folder,
            'world_dir': world, 'hedge_phrases': HEDGES, 'settings_record': setting_row()}
