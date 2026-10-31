"""The voice-lines step: a take of every voiced line of the plans, made by the request's speaker, kept in the voice folder.

A voiced line is a segment whose piece is voiced_line in the request's piece table. A take is <name>.wav beside <name>.txt holding
its exact text, so the cutter finds a take by its words, never by its name; a new take is named by the BLAKE3 of its text.
The speaker is DATA, "voice": {"folder", "say": [{"argv": [...]}, ...]}: the commands run in order for each missing line, with
  {"fill": "text"}       the line's words
  {"fill": "text_file"}  a file holding them
  {"fill": "work"}       a folder of its own for in-between files
  {"fill": "out"}        the take to write (the last command must write it)
"""
import json
import subprocess
import tempfile
from pathlib import Path

from blake3 import blake3

from cut import voice_takes
from fill import Refused, fill
from plan_pieces import pieces_of


def voiced_lines(plan_files, table):
    texts = []
    for f in plan_files:
        plan = json.loads(Path(f).read_text())
        if (plan.get('format') or {}).get('option') not in table['formats']:
            continue
        rows = pieces_of(plan, table)
        for s in plan['segments']:
            if rows[s['kind']]['piece'] == 'voiced_line' and s['text'] not in texts:
                texts.append(s['text'])
    return texts


def voice_lines(req, plan_files):
    voice = req.get('voice') or {}
    if not voice.get('folder'):
        raise Refused('the request needs voice.folder, where takes are kept')
    folder = Path(voice['folder'])
    folder.mkdir(parents=True, exist_ok=True)
    texts = voiced_lines(plan_files, req['pieces'])
    have = voice_takes(folder)
    todo = [t for t in texts if t not in have]
    if todo and not voice.get('say'):
        raise Refused(f'{len(todo)} voiced lines have no take and the request names no voice.say commands to make them')
    made = []
    for text in todo:
        name = blake3(text.encode()).hexdigest()[:16]
        out = folder / f'{name}.wav'
        with tempfile.TemporaryDirectory(prefix='voice-line-') as work:
            text_file = Path(work) / 'line.txt'
            text_file.write_text(text)
            values = {'text': text, 'text_file': str(text_file), 'work': work, 'out': str(out)}
            for step in voice['say']:
                argv = [str(a) for a in fill(step['argv'], values)]
                r = subprocess.run(argv, capture_output=True, text=True)
                if r.returncode:
                    raise Refused(f'voice.say {argv[0]} failed on {text[:60]!r}: {r.stderr.strip()[-600:]}')
        if not out.is_file():
            raise Refused(f'voice.say ran but wrote no {out}')
        (folder / f'{name}.txt').write_text(text)
        made.append({'text': text, 'take': str(out)})
    return {'lines': len(texts), 'had': len(texts) - len(todo), 'made': made}
