"""bridge: every move from one spoken line to the next is followable by a first-time viewer; when the subject,
speaker, tone or purpose changes, a spoken bridge carries it (for example a question to the speaker followed straight by a line about
them in the third person has no bridge). Checked over the WHOLE spoken sequence of the video, not where anyone pointed.

The sequence is the video's speech-to-text (the same word timings word-clip uses), cut into sentences. A sentence is the inserted voice's
(a narrator laid over the footage) when its middle falls inside the window the spec gives that voice (edit overlay start + voice.start_s,
as long as its word timings run); every other sentence is the speaker's own footage. Each sentence is labelled with the limits'
inserted_label or speaker_label (the names the question shows the model). Each adjacent pair goes to a local language model (ollama; the
model, the question and the answer shape are in the limits, bridge) which answers whether line B changes the subject, speaker or purpose
and quotes the transition words that open B. The verdict is made here, not by the model: a jump is `changes` with no transition word left
once the not_a_transition words are dropped (a pronoun alone is not a bridge). Answers are cached by (model, prompt, pair) in the cache
folder, so a rerun is identical.

A jump at an inserted line, or across a hold or cut join, is a FAIL: the video's own line or edit lacks a bridge. A jump between two lines
of the speaker's own footage is an INFO note only: the speaker's script is theirs. A pair the model cannot be asked (no model running) is
"not measured"."""
import hashlib
import json
import os
import re
import tempfile
import time
import urllib.request

from ..report import Finding

NAME = 'bridge'


def needs(ctx):
    return None if ctx.info['has_audio'] else 'the video has no audio'


def sentences(words):
    out, cur = [], []
    for w in words:
        cur.append(w)
        if re.search(r'[.?!]["\')]*$', w['w'].strip()):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return [{'text': ' '.join(x['w'].strip() for x in s).replace(' ,', ','), 's': s[0]['s'], 'e': s[-1]['e']} for s in out]


def inserted_window(ctx):
    """(start, end) preview seconds of the inserted voice, from the spec's voice.words (a word timings file) and voice.start_s, or None."""
    voice = ctx.spec.get('voice') or {}
    if not voice.get('words') or ctx.overlay_t0 is None:
        return None
    from .. import jsonio
    vw = jsonio.read(voice['words'])
    vw = vw['words'] if isinstance(vw, dict) else vw
    start = ctx.overlay_t0 + voice.get('start_s', 0.0)
    return start, start + max(w.get('e', w.get('end', 0.0)) for w in vw)


def label(sentences_, window, slack, inserted, speaker):
    for s in sentences_:
        if window:
            mid = (s['s'] + s['e']) / 2
            s['who'] = inserted if window[0] - slack <= mid <= window[1] + slack else speaker
        else:
            s['who'] = speaker


def ask(cfg, a, b):
    """The model's answer for one pair, from the cache or from ollama (attempts tries, backoff_s doubling between them, so a loaded computer gets time). Returns None when no answer came: the pair is then not measured, which blocks the row."""
    prompt = cfg['prompt'].format(sa=a['who'], a=a['text'], sb=b['who'], b=b['text'])
    key = hashlib.blake2b(json.dumps([cfg['model'], cfg['prompt'], a['who'], a['text'], b['who'], b['text']]).encode(), digest_size=10).hexdigest()
    cache = cfg.get('cache_dir') or os.path.join(tempfile.gettempdir(), 'check-a-rendered-video-cache')      # run() passes the context's cache folder
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f'bridge-{key}.json')
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    body = json.dumps({'model': cfg['model'], 'prompt': prompt, 'stream': False, 'format': 'json', 'keep_alive': cfg['keep_alive'], 'options': {'temperature': 0, 'num_predict': 200}}).encode()
    for attempt in range(cfg['attempts']):
        if attempt:
            time.sleep(cfg['backoff_s'] * 2 ** (attempt - 1))
        try:
            req = urllib.request.Request(cfg['endpoint'], body, {'Content-Type': 'application/json'})
            answer = json.loads(json.loads(urllib.request.urlopen(req, timeout=cfg['timeout_s']).read())['response'])
        except (OSError, ValueError, KeyError):
            continue
        if isinstance(answer, dict):
            with open(path, 'w') as f:
                json.dump(answer, f)
            return answer
    return None


def is_jump(answer, cfg):
    words = [w for w in re.findall(r"[a-z']+", str(answer.get('link', 'none')).lower()) if w not in set(cfg['not_a_transition'])]
    return bool(answer.get('changes')) and not words


def run(ctx):
    cfg = dict(ctx.cfg['bridge'], cache_dir=ctx.cfg['bridge'].get('cache_dir') or ctx.cache_dir)
    sents = sentences(ctx.preview_words())
    label(sents, inserted_window(ctx), cfg['inserted_slack_s'], cfg['inserted_label'], cfg['speaker_label'])
    joins = [j['t'] for j in ctx.joins()]
    out = []
    if len(sents) < 2:
        return [Finding(NAME, 'INFO', f'{len(sents)} spoken sentence(s); no pair to judge')]
    for a, b in zip(sents, sents[1:]):
        across_join = any(a['e'] - cfg['join_slack_s'] <= j <= b['s'] + cfg['join_slack_s'] for j in joins)
        inserted = cfg['inserted_label'] in (a['who'], b['who'])
        answer = ask(cfg, a, b)
        pair = f'"{a["text"][-60:]}" -> "{b["text"][:60]}"'
        if answer is None:
            out.append(Finding(NAME, 'WARN', f'the model could not be asked ({cfg["model"]} at {cfg["endpoint"]}), after {cfg["attempts"]} tries, so this pair is not measured (blocking, not a pass): {pair}', b['s'], data={'not_measured': True}))
        elif is_jump(answer, cfg):
            kind = 'FAIL' if (inserted or across_join) else 'INFO'
            where = 'at an inserted line' if inserted else 'across a join' if across_join else 'inside the speaker\'s own footage (note only: the speaker\'s script is theirs)'
            out.append(Finding(NAME, kind, f'no bridge {where} ({answer.get("why", "")}): {pair}', b['s'], data={'pair': [a['text'], b['text']], 'who': [a['who'], b['who']], 'answer': answer}))
        else:
            out.append(Finding(NAME, 'INFO', f'ok ({answer.get("link", "")!s}): {pair}', b['s']))
    return out
