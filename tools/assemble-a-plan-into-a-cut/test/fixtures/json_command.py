"""A made-up JSON command: capture its actual input and print the response/process exit supplied by the test."""
import json
import sys
from pathlib import Path

request = json.load(sys.stdin)
if request.get('capture'):
    Path(request['capture']).write_text(json.dumps(request))
print('made-up command log')
print(request['raw_stdout'] if 'raw_stdout' in request else json.dumps(request.get('response', {'result': {'exit': 0}})))
sys.exit(request.get('process_exit', 0))
