"""check-a-rendered-video review-pack <videos-dir> --out <dir> --rules <rules.json> --limits <file>: the inputs a fresh-viewer reviewer needs for each video, and nothing else.
Per video <out>/<id>/: sheet-NN.jpg (one frame per second, time-stamped, 16 tiles a sheet), transcript.txt (the video's speech-to-text, a line per
sentence with its start time, speakers unlabelled) and rules.txt (the rows of the rules file whose `kinds` include --kind, default film-edit: ids and wording).
No spec, no notes, no checker output goes in, so the reviewer starts with no idea what to look for. The reviewer's findings are notes to verify, never a pass or a fail."""
import glob
import os
import subprocess

from . import jsonio
from .ctx import Context
from .checks.bridge import sentences

TILES = 16


def transcript(words):
    return '\n'.join(f'{int(s["s"]) // 60:02d}:{int(s["s"]) % 60:02d} {s["text"]}' for s in sentences(words))


def rules_text(rules_path, kind='film-edit'):
    """The rows of a rules file ({rows: [{id, rule, kinds}]}) of the given kind, one `- id: rule` line each."""
    return '\n'.join(f'- {r["id"]}: {r["rule"]}' for r in jsonio.read(rules_path)['rows'] if kind in r['kinds'])


def pack_one(preview, cfg, out_dir, rules, cache_dir=None):
    os.makedirs(out_dir, exist_ok=True)
    for old in glob.glob(os.path.join(out_dir, 'sheet-*.jpg')):
        os.unlink(old)
    vf = ("fps=1,scale=480:-1,drawtext=text='%{pts\\:hms}':x=6:y=6:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x4")
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', preview, '-vf', vf, '-q:v', '4', os.path.join(out_dir, 'sheet-%02d.jpg')], check=True)
    ctx = Context(preview, {}, cfg, cache_dir=cache_dir)
    with open(os.path.join(out_dir, 'transcript.txt'), 'w') as f:
        f.write(transcript(ctx.preview_words()) + '\n')
    with open(os.path.join(out_dir, 'rules.txt'), 'w') as f:
        f.write(rules + '\n')
    return out_dir


def run(previews_dir, out, rules_path, cfg, ids=None, kind='film-edit', cache_dir=None):
    rules = rules_text(rules_path, kind)
    packs = []
    for pv in sorted(glob.glob(os.path.join(previews_dir, '*.mp4'))):
        if ids and os.path.splitext(os.path.basename(pv))[0] not in ids:
            continue
        packs.append(pack_one(pv, cfg, os.path.join(out, os.path.splitext(os.path.basename(pv))[0]), rules, cache_dir))
    return packs
