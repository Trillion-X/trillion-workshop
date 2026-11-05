"""Work out a recipe's nutrients from USDA FoodData Central downloads: one JSON request in, one JSON answer out.

usage: python3 -I do-work/work_out_recipe_nutrients.py < request.json
       python3 -I do-work/work_out_recipe_nutrients.py --request request.json

The request holds the recipe (ingredients, grams or portions, FoodData Central ids) and the datasets, each as
{"dir": "<unzipped download folder>"} or as the CSV texts {"food_nutrient": "...", "food_portion": "...", ...}.
With "write_to": "<folder>" it also writes <id>.profile.json and <id>.recipe.json there (indent 1).
The last line printed is the answer: {"profile", "recipe", "summary_lines", "written"} or {"error": "what to change"}.
"""
import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
READ_DATA = os.path.join(os.path.dirname(HERE), 'read-data')
SETTINGS = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'settings', 'read-data')
sys.path.insert(0, READ_DATA)
sys.path.insert(1, SETTINGS)

from fooddata_central import Refusal, load_dir, load_texts  # noqa: E402
from recipe_profile import work_out  # noqa: E402
import settings  # noqa: E402  (tools/settings, the one reader of list:settings)

FOLDER = 'work-out-a-recipes-nutrients-from-fooddata-central'
TOOL = 'tool:' + FOLDER


def with_saved_recipe(request):
    """The request with the person's saved recipe under it: settings_record is their list:settings row(s)
    (record:setting:<FOLDER>~piece~<piece>), read through tools/settings at scope piece (the request's `piece`);
    a field the request gives itself wins."""
    if 'settings_record' not in request:
        return request
    scopes = [('piece', str(request['piece']))] if request.get('piece') is not None else None
    try:
        saved = settings.setting(request['settings_record'], FOLDER, scopes, default=None, tool=TOOL)
    except settings.SettingError as e:
        raise Refusal(str(e))
    if saved is None:
        raise Refusal(f'no list:settings row for piece {request.get("piece")} was given: pass the row record:setting:{FOLDER}~piece~<piece> as settings_record')
    if not isinstance(saved, dict):
        raise Refusal('the saved recipe must be an object of request fields (id, ingredients, ...)')
    merged = dict(saved)
    merged.update({k: v for k, v in request.items() if k not in ('settings_record', 'piece')})
    return merged


def read_request(argv):
    if '--request' in argv:
        i = argv.index('--request')
        if i + 1 >= len(argv):
            raise Refusal('--request needs the path of a JSON request file')
        try:
            with open(argv[i + 1], encoding='utf-8') as f:
                text = f.read()
        except OSError:
            raise Refusal(f'{argv[i + 1]} is not there: pass the JSON request file')
    else:
        text = sys.stdin.read()
    try:
        request = json.loads(text)
    except ValueError:
        raise Refusal('the request is not JSON: send one JSON object on standard input or with --request <file>')
    if not isinstance(request, dict):
        raise Refusal('the request must be a JSON object with id, datasets and ingredients')
    return request


def answer(request):
    request = with_saved_recipe(request)
    if not isinstance(request.get('id'), str) or not request['id']:
        raise Refusal('the request needs an id for the recipe (a short name such as "made-up-smoothie")')
    datasets = request.get('datasets')
    if not isinstance(datasets, dict) or not datasets:
        raise Refusal('the request needs datasets: {"<name>": {"dir": "<FoodData Central download folder>"}} or the CSV texts')
    tables = {}
    for name, given in datasets.items():
        if not isinstance(given, dict):
            raise Refusal(f'dataset {name} must be an object: {{"dir": ...}} or the CSV texts')
        tables[name] = load_dir(given['dir'], name) if 'dir' in given else load_texts(given, name)
    built = request.get('built') or datetime.datetime.now().astimezone().isoformat(timespec='seconds')
    result = work_out(request, tables, built)
    written = []
    if request.get('write_to'):
        out = request['write_to']
        if not os.path.isdir(out):
            raise Refusal(f'write_to {out} is not a folder: make it first or leave write_to out')
        for part in ('profile', 'recipe'):
            path = os.path.join(out, f'{request["id"]}.{part}.json')
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(result[part], f, indent=1)
            written.append(path)
    result['written'] = written
    return result


def main(argv):
    try:
        result = answer(read_request(argv))
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 1
    except (KeyError, ValueError, TypeError) as e:
        print(json.dumps({'error': f'the request or a CSV is not in the shape this reads ({type(e).__name__}: {e}); see the README input'}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
