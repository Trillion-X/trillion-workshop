"""Reading media with ffprobe and ffmpeg (lengths, streams, frames for analysis), and handing edits to the Workshop's
media-composition renderer. This file renders nothing itself: every cut, still and reel is an edit (media-composition's EDL)
rendered by tools/media-composition/do-work/render-an-edit.mjs, and the shot match is its match-shots.mjs.
"""
import json
import shutil
import subprocess
from pathlib import Path

from fill import Refused

FILTER_SPECIAL = set(":,;[]=\\")
COMPOSITION = Path(__file__).resolve().parents[2] / 'media-composition' / 'do-work'


def run(cmd):
    r = subprocess.run(['ffmpeg', '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', *cmd], capture_output=True, text=True)
    if r.returncode:
        raise Refused(f"ffmpeg failed ({r.returncode}): {r.stderr.strip()[-800:]}")


def probe_dur(p):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(p)],
                                capture_output=True, text=True, check=True).stdout)


def stream_kinds(p):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(p)], capture_output=True, text=True).stdout
    return json.loads(out or '{}')


def has_picture(p):
    """True when the file has a video stream that is not a cover picture"""
    return any(s.get('codec_type') == 'video' and not s.get('disposition', {}).get('attached_pic') for s in stream_kinds(p).get('streams', []))


def fps_text(rules):
    n, d = rules['frame']['fps']
    return f'{n}/{d}'


def frame_s(rules):
    n, d = rules['frame']['fps']
    return d / n


def frames(seconds, rules):
    n, d = rules['frame']['fps']
    return round(seconds * n / d)


def _option(v):
    text = str(v)
    if "'" in text:
        raise Refused(f"a look filter option holds a quote ({text}); rename the file or give the value without one")
    return f"'{text}'" if FILTER_SPECIAL & set(text) else text


def filter_chain(steps):
    """an ffmpeg filter chain from DATA steps [{"filter": name, "options": {key: value}}]: a look, as the edit's clip grade"""
    parts = []
    for step in steps:
        opts = step.get('options') or {}
        parts.append(step['filter'] + ('=' + ':'.join(f'{k}={_option(v)}' for k, v in opts.items()) if opts else ''))
    return ','.join(parts)


def fitted(look, rules):
    """the chain a frame is read through for analysis (face reading, calm sides): fitted inside the cut's frame with black bars,
    as the edit's clips are (reframe fill_mode black), then the clip's look"""
    w, h = rules['frame']['width'], rules['frame']['height']
    chain = [f'scale={w}:{h}:force_original_aspect_ratio=decrease', f'pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black', 'setsar=1', 'format=yuv420p']
    return ','.join(chain + ([look] if look else []))


def _node():
    node = shutil.which('node')
    if not node:
        raise Refused('node is not on PATH: the cut is rendered by the Workshop tool media-composition, which runs on node 22 or later')
    return node


def _composition(tool, args):
    script = COMPOSITION / tool
    if not script.is_file():
        raise Refused(f'{script} is missing: this tool renders through the Workshop tool media-composition, beside it in tools/')
    r = subprocess.run([_node(), str(script), *args], capture_output=True, text=True)
    if r.returncode:
        raise Refused(f'media-composition {tool} refused: {r.stderr.strip()[-1200:]}')
    return json.loads(r.stdout.strip().splitlines()[-1])


def render(edl, out, workdir):
    """render one edit to out with media-composition's render-an-edit, its pieces made in workdir; the measured result"""
    Path(workdir).mkdir(parents=True, exist_ok=True)
    return _composition('render-an-edit.mjs', ['--edl', json.dumps(edl), '--output', str(out), '--workdir', str(workdir)])


def match_shots(edl, folder, rules):
    """the edit with each clip that names shot_match graded toward its group's one look (media-composition match-shots.mjs),
    its LUTs written to folder, measured by the rules' shot_match numbers"""
    sm = rules['shot_match']
    return _composition('match-shots.mjs', ['--edl', json.dumps(edl), '--folder', str(folder), '--samples', str(sm['samples']),
                                             '--edge-s', str(sm['edge_s']), '--min-span-s', str(sm['min_span_s']), '--strength', str(sm['strength'])])


def complete(path, seconds, rules):
    """the file has one video and one audio stream and lasts the cut's seconds (within the rules' tolerance)"""
    p = stream_kinds(path)
    kinds = sorted(s['codec_type'] for s in p.get('streams', []))
    return kinds == ['audio', 'video'] and abs(float(p.get('format', {}).get('duration', 0)) - seconds) <= rules['complete']['duration_tolerance_s']
