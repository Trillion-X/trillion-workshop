"""A made-up records door for the records:write sender's tests, played like a call program: `fake_record_door.py PLAN RESULT`.

Its account is the JSON file named by FAKE_DOOR: { "records": { id: { type, value } }, "keys": { request_key: answer }, "refuse_id": id,
"calls": [] }. `list` answers a page of one type's records in id order ({ records, next }); `write` keeps every record (value null removes)
and answers { changed, write_count, replayed }; a repeated request key answers its first answer with replayed true and writes nothing; a
write naming `refuse_id` is refused. Every call is logged in `calls`."""
import json
import os
import sys

path = os.environ['FAKE_DOOR']
state = json.load(open(path))
plan, result = sys.argv[1], sys.argv[2]
lines = []
for step in json.load(open(plan))['requests']:
    args = step['arguments']
    method, key, given = args['method'], args['request_key'], args['input']
    state['calls'].append({'method': method, 'request_key': key, 'records': len(given.get('records', []))})
    if method == 'list':
        ids = sorted(i for i, r in state['records'].items() if r['type'] == given['type'] and i.startswith(given.get('prefix', '')))
        start = ids.index(given['after']) + 1 if given.get('after') in ids else 0
        page = ids[start:start + given['limit']]
        more = start + given['limit'] < len(ids)
        answer, error = {'records': [{'id': i, **state['records'][i]} for i in page], 'next': page[-1] if more else None}, False
        if 'fields' in given:
            answer['records'] = [{'id': r['id'], 'type': r['type'],
                                 **({'value': {k: v for k, v in r['value'].items() if k in given['fields']}} if given['fields'] else {})}
                                for r in answer['records']]
    elif key in state['keys']:
        answer, error = {**state['keys'][key], 'replayed': True}, False
    elif any(r['id'] == state.get('refuse_id') for r in given['records']):
        answer, error = {'code': 'record_refused', 'outcome': 'not_started'}, True
    elif len(given['records']) > state.get('slow_over', 10 ** 9):
        answer, error = {'code': 'too_slow', 'outcome': 'not_started'}, True
    elif any('expected' in r and state['records'].get(r['id']) != r['expected'] for r in given['records']):
        answer, error = {'code': 'original_command_conflict', 'outcome': 'not_started'}, True
    else:
        changed = 0
        for record in given['records']:
            before = state['records'].get(record['id'])
            if record['value'] is None:
                changed += state['records'].pop(record['id'], None) is not None
            else:
                changed += before is None or before['value'] != record['value']
                state['records'][record['id']] = {'type': record['type'], 'value': record['value']}
        answer, error = {'changed': bool(changed), 'write_count': changed, 'replayed': False}, False
        state['keys'][key] = {'changed': bool(changed), 'write_count': changed}
        if state.get('unknown_first') and not state.get('was_unknown'):
            state['was_unknown'] = True
            answer, error = {'code': 'outcome_unknown', 'outcome': 'unknown'}, True
    lines.append({'name': step['name'], 'is_error': error, 'answer': answer})
json.dump(state, open(path, 'w'))
with open(result, 'w') as out:
    out.write(''.join(json.dumps(line) + '\n' for line in lines) + json.dumps({'personal_key_in_any_answer': False}) + '\n')
