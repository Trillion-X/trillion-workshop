"""Read-back check of one spoken line: every word of the script must be heard back, in order, in the words a Whisper
model heard from the clip. Deterministic, no model.

usage: python3 -I read_back_check.py SCRIPT_TEXT HEARD_JSON_FILE

HEARD_JSON_FILE holds the words tool:hear-sources answered: a list of {text, ...} rows in time order (or {"words": [...]}).
Both sides are normalized the same way: lowercase, apostrophes dropped, every other character that is not an ASCII letter or
digit becomes a space, and each integer below 100 is spelled in words (so "4" and "four" match). The check then requires each script word to
appear in the heard words after the previous script word's match: a missing or swapped word fails the line, extra
heard words do not.

Prints one line {"result": {"ok", "script_words", "missing"}} or {"error": "what to change"}.
Exit 0 when every word reads back, 1 when some do not, 2 when the input is refused.
"""
import json
import re
import sys

ONES = ('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen '
        'seventeen eighteen nineteen').split()
TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']


def spell(n):
    if n < 20:
        return ONES[n]
    return TENS[n // 10] if n % 10 == 0 else f'{TENS[n // 10]} {ONES[n % 10]}'


def words(text):
    text = re.sub(r'\d+', lambda m: spell(int(m.group())) if int(m.group()) < 100 else m.group(), text.lower())
    text = re.sub(r"['\u2019]", '', text)
    return re.sub(r'[^a-z0-9]+', ' ', text).split()


def missing_in_order(script, heard):
    missing, pos = [], 0
    for w in script:
        try:
            pos = heard.index(w, pos) + 1
        except ValueError:
            missing.append(w)
    return missing


def heard_text(rows):
    if isinstance(rows, dict):
        rows = rows.get('words')
    if not isinstance(rows, list) or not all(isinstance(r, dict) and isinstance(r.get('text'), str) for r in rows):
        raise ValueError('the heard file must be a list of {text} rows, as tool:hear-sources answers them')
    return ' '.join(r['text'] for r in rows)


def main(argv):
    if len(argv) != 2:
        print(json.dumps({'error': 'usage: read_back_check.py SCRIPT_TEXT HEARD_JSON_FILE'}))
        return 2
    script = words(argv[0])
    if not script:
        print(json.dumps({'error': 'the script has no words to read back: pass the line text'}))
        return 2
    try:
        with open(argv[1], encoding='utf8') as f:
            heard = words(heard_text(json.load(f)))
    except (OSError, ValueError) as e:
        print(json.dumps({'error': str(e)}))
        return 2
    missing = missing_in_order(script, heard)
    print(json.dumps({'result': {'ok': not missing, 'script_words': len(script), 'missing': missing}}))
    return 0 if not missing else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
