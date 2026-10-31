"""math-shown: when numbers on screen relate, the graphic does the math for the viewer and the arithmetic is right (for example 976 eaten, 1,500 base rate, deficit 524).
Every string the spec puts on screen is read for numbers (thousands commas, decimals, a % or unit after). Two findings:
  - a wrong equation: a string that writes `a op b = c` (+, -, x, *, /, with the usual unicode signs, one or more operators) whose result is not c within math_shown.tolerance
    (rounding to the digits written) fails;
  - an unshown relation: three numbers of the video (each at least min_value, years and 1-9 excluded) where one is the sum, difference, product or ratio of two others, and no
    string of the video writes an equation or an operation word (total, sum, deficit, difference, left, remaining, per, times, saved, over, under, vs) in the same event as the result,
    fails: the numbers relate and the viewer is left to do the arithmetic.
  - a result word without a result: an event that labels a result (deficit, difference, total, remaining, saved) and writes two or more numbers within window_strings strings of it but none that
    is the sum, difference, product or ratio of those fails: "976 eaten, 1,500 base rate, deficit" with no 524.
A video with fewer than three numbers is an empty set."""
import itertools
import re

from ..report import Finding
from .dwell import element_strings

NAME = 'math-shown'
EMPTY_SET = 'fewer than three numbers on screen'

NUM = r'\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?'
OPS = r'[+\-−–x×*/÷]'
EQ = re.compile(rf'((?:{NUM})(?:\s*{OPS}\s*(?:{NUM}))+)\s*=\s*(-?\s*(?:{NUM}))', re.I)


def value(text):
    return float(text.replace(',', '').replace(' ', ''))


def numbers(text):
    return [value(m) for m in re.findall(NUM, text)]


def evaluate(expr):
    """Left-to-right value of `a op b op c` with the usual signs; x, * and / bind tighter."""
    toks = re.findall(rf'({NUM})|({OPS})', expr)
    vals, ops = [value(n) for n, _ in toks if n], [o.lower() for _, o in toks if o]
    i = 0
    while i < len(ops):
        if ops[i] in 'x×*/÷':
            vals[i] = vals[i] * vals[i + 1] if ops[i] in 'x×*' else vals[i] / vals[i + 1]
            del vals[i + 1], ops[i]
        else:
            i += 1
    out = vals[0]
    for o, v in zip(ops, vals[1:]):
        out = out + v if o == '+' else out - v
    return out


def strings(ctx, c):
    skip = set(ctx.cfg['dwell']['non_text_keys']) | set(c['skip_keys'])
    return [(ev, ' '.join(s.split())) for ev in ctx.spec.get('events', []) for s in element_strings(ev, skip) if s.strip() and not s.startswith('/')]


def needs(ctx):
    c = ctx.cfg['math_shown']
    return None if len([n for _, s in strings(ctx, c) for n in numbers(s)]) >= 3 else EMPTY_SET


def related(vals, c, equal=True):
    """[(a, op, b, result)] among distinct values of at least min_value."""
    vs = sorted({v for v in vals if v >= c['min_value'] and not 1900 <= v <= 2100})
    out = []
    for a, b in (itertools.combinations_with_replacement if equal else itertools.combinations)(vs, 2):
        for r in vs:
            if r in (a, b) and a != b or (a == b and r == a):
                continue
            for op, x in (('+', a + b), ('x', a * b), ('/', b / a if a else None)):      # a difference is a sum read the other way: r + b = a
                if x is not None and abs(x - r) <= max(c['tolerance'] * abs(r), 0.5) and (op != 'x' or max(a, b) > 1):
                    out.append((a, op, b, r))
    return out


def run(ctx):
    c = ctx.cfg['math_shown']
    items = strings(ctx, c)
    out = []
    equations = []
    for ev, s in items:
        for m in EQ.finditer(s):
            got, shown = evaluate(m.group(1)), value(m.group(2).replace('-', ''))
            equations.append((ev, m.group(0)))
            if abs(abs(got) - shown) > max(c['tolerance'] * shown, 0.5):
                out.append(Finding(NAME, 'FAIL', f'{ev["type"]} "{ev.get("id")}" writes "{m.group(0)}" but the arithmetic gives {got:g}: fix the number on screen', data={'equation': m.group(0), 'result': got}))
    vals = [n for _, s in items for n in numbers(s)]
    words = re.compile(r'(?i)\b(' + '|'.join(c['operation_words']) + r')\b')
    shown_in = {id(ev) for ev, s in items if words.search(s)} | {id(ev) for ev, _ in equations}
    for a, op, b, r in related(vals, c, equal=False):
        holders = [ev for ev, s in items if {a, b, r} & set(numbers(s))]
        if holders and not any(id(ev) in shown_in for ev in holders):
            out.append(Finding(NAME, 'FAIL', f'the numbers {a:g}, {b:g} and {r:g} relate ({a:g} {op} {b:g} = {r:g}) but no graphic shows the operation: write it ("{a:g} {op} {b:g} = {r:g}", or the subtraction that gives one of them) or label the result (total, deficit, difference), so the viewer does not do the math',
                               data={'a': a, 'b': b, 'op': op, 'result': r}))
            break
    by_event = {}
    for ev, s_ in items:
        by_event.setdefault(id(ev), (ev, []))[1].append(s_)
    result_words = re.compile(r'(?i)\b(' + '|'.join(c['result_words']) + r')\b')
    for ev, texts in by_event.values():
        for k, text in enumerate(texts):
            word = result_words.search(text)
            if not word:
                continue
            near = texts[max(k - c['window_strings'], 0):k + c['window_strings'] + 1]      # the strings written around the result word
            nums = [n for t in near for n in numbers(t)]
            if len([n for n in nums if n >= c['min_value']]) >= 2 and not related(nums, c):
                out.append(Finding(NAME, 'FAIL', f'{ev["type"]} "{ev.get("id")}" labels "{word.group(0)}" but none of the numbers around it is its result ({", ".join(f"{n:g}" for n in nums if n >= c["min_value"])}): compute it on screen, so the viewer does not do the math',
                                   data={'word': word.group(0)}))
                break
    return out or [Finding(NAME, 'INFO', f'{len(vals)} numbers read; {len(equations)} equations written and right; no relation left unshown')]
