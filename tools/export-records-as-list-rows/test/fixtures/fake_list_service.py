"""A made-up list service for the sender's tests: `put` keeps the rows it is given (answering { "kept": [ids] }), `warm` only logs.
Its behaviour is in the JSON file named by FAKE_SERVICE: { "busy_first": n, "max_rows": m, "refuse_list": id, "calls": [] }; every call is logged there."""
import json
import os
import sys

path = os.environ['FAKE_SERVICE']
state = json.load(open(path))
request = json.load(sys.stdin)
mode = sys.argv[1]
state['calls'].append({'mode': mode, 'list_id': request['list_id'], 'rows': len(request.get('rows', []))})
answer = None
if mode == 'put':
    if state.get('busy_first', 0) > 0:
        state['busy_first'] -= 1
        answer = ('the list book is catching up', 1)
    elif len(request['rows']) > state.get('max_rows', 10 ** 9):
        answer = ('memory limit reached', 1)
    elif request['list_id'] == state.get('refuse_list'):
        answer = ('these records are refused', 1)
json.dump(state, open(path, 'w'))
if answer:
    print(answer[0], file=sys.stderr)
    raise SystemExit(answer[1])
print(json.dumps({'kept': [r['id'] for r in request.get('rows', [])]}))
