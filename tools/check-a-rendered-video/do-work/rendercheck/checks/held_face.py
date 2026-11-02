"""held-face: a hold, freeze or still of the person (edit.hold, which also covers a held first frame and a stitched cold open that starts on a hold) must
not freeze on a frame that reads as a blink or half-closed eyes, nor, for a long hold, on a mouth caught mid-word (for example a frame frozen for half a minute
with the eyes half-closed).
The held picture is read from what plays during the hold (a hold_picture still, a full-frame still the spec lays over the footage, the base footage of placement.bases
at the source second the hold starts on, or else the delivered video at sample_fractions of the hold), and Apple Vision's face landmarks (vision_landmarks.py, run with
a python that has the Vision and Quartz bindings: the env LANDMARKS_PYTHON, else the limits' held_face.python) give the eye openness (contour height / width, the lower
of the two eyes) and the mouth openness (inner lips height / width) of the largest face. FAIL when the eyes are under eye_open_min on a hold of min_hold_s or more;
WARN when the mouth is at least mouth_open_warn on a hold of mouth_min_hold_s or more. No face found, or Vision not available, is a WARN that the hold is not
measured, never a pass. A spec with no hold is an empty set."""
import json
import os
import re
import subprocess
import tempfile

from PIL import Image

from .. import media
from ..report import Finding
from .placement import base_footage

NAME = 'held-face'
EMPTY_SET = 'no hold, freeze or still of the person'      # a spec fact: reported as a pass, not a skip

HELPER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'vision_landmarks.py')


def holds(ctx):
    """[(preview second the hold starts, seconds, its hold_picture or None)] of the holds that play inside the preview: one per edit.hold (ctx.hold_spans), or one per
    edit.hold_picture when the spec has no hold of its own. A hold's picture is the hold_picture whose `at` (a time after all holds) is the hold's start within one frame."""
    pictures = ctx.hold_pictures()
    spans = [(start, secs) for start, secs, _ in ctx.hold_spans()] or [(float(p['at']), float(p['seconds'])) for p in pictures]
    out = []
    for at, secs in spans:
        start = at - ctx.p0
        if -1e-6 <= start < ctx.info['duration']:
            out.append((start, secs, next((p for p in pictures if abs(p['at'] - at) <= 1.0 / ctx.fps), None)))
    return out


def hold_picture_image(ctx, picture):
    """The still a hold_picture puts on screen during its hold (its `image`, a frame with the eyes open), or None. A relative path is read from the folder
    placement.lane_root_regex matches in the video's path, when the limits give one and it matches, else from the video's own folder."""
    img = picture.get('image')
    if not img:
        return None
    root = ctx.cfg['placement'].get('lane_root_regex')
    lane = re.match(root, ctx.preview) if root else None
    for p in ([img] if os.path.isabs(img) else [os.path.join(lane.group(0) if lane else os.path.dirname(ctx.preview), img)]):
        if os.path.isfile(p):
            return p
    return None


def needs(ctx):
    return None if holds(ctx) else EMPTY_SET


def read_landmarks(ctx, images):
    """{image: [faces]} from the Vision helper in the configured python; None when it cannot run. Tests replace this function."""
    py = os.environ.get('LANDMARKS_PYTHON') or os.path.expanduser(ctx.cfg['held_face'].get('python') or '')      # a python with the Vision and Quartz bindings (macOS)
    if not py or not os.path.isfile(py):
        return None
    r = subprocess.run([py, HELPER, *images], capture_output=True, text=True, timeout=ctx.cfg['held_face']['timeout_s'])
    if r.returncode:
        return None
    return json.loads(r.stdout.strip().splitlines()[-1])


def held_picture(ctx, start, secs, picture, tmp):
    """([image paths], why not or None, what it is): the picture the hold freezes. Its hold_picture still, when it has one. A still the spec lays over the whole frame for the hold (an event with an existing `image` file and
    covers_a_roll) is what plays. Otherwise the frame of the footage the hold freezes: the lane's base footage (placement.bases) at the cut second the hold starts on; a lane with
    none configured reads the delivered preview in the middle of the hold. The delivered frame is not used where a base is configured: graphics over it may show other faces of the person."""
    c, covers = ctx.cfg['held_face'], ctx.cfg['placement']['cover_key']
    if picture:      # on its own video track under the overlay: what plays during the hold; a missing file is not measured, never the footage beneath
        img = hold_picture_image(ctx, picture)
        return ([img], None, 'the hold_picture still') if img else ([], f'the hold_picture image {picture.get("image")} is not on disk', 'the hold_picture still')
    for ev in ctx.spec.get('events', []):
        if ev.get(covers) and ev.get('image') and os.path.isfile(ev['image']):
            return [ev['image']], None, f'the still "{ev.get("id") or ev.get("type")}"'
    w, h = c['frame_width'], c['frame_height']
    bases = base_footage(ctx, ctx.cfg['placement'])
    if bases:
        src = ctx.source_time(start)
        span = next((s for s in bases if s[1] <= src < s[2] and os.path.isfile(s[0])), None)
        if span is None:
            return [], f'the footage at source second {src:.2f} is in no base span on disk', 'the base footage'
        p = os.path.join(tmp, 'src.png')
        Image.fromarray(media.frames(span[0], w, h, 'rgb24', ss=src - span[1], t=0.05)[0]).save(p)
        return [p], None, f'the base footage at source second {src:.2f}'
    images = []
    for k, f in enumerate(c['sample_fractions']):
        p = os.path.join(tmp, f'h{k}.png')
        Image.fromarray(media.frames(ctx.preview, w, h, 'rgb24', ss=min(start + secs * f, ctx.info['duration'] - 0.05), t=0.05)[0]).save(p)
        images.append(p)
    return images, None, 'the delivered frame'


def run(ctx):
    c = ctx.cfg['held_face']
    out = []
    for start, secs, picture in holds(ctx):
        label = f'hold at {start:.2f}s ({secs:.1f}s)'
        with tempfile.TemporaryDirectory() as tmp:
            images, why, what = held_picture(ctx, start, secs, picture, tmp)
            if why:
                out.append(Finding(NAME, 'WARN', f'{label}: {why}, so the held frame is not measured', start, data={'not_measured': True, 'unreached': True}))
                continue
            got = read_landmarks(ctx, images)
        label += f' on {what}'
        if got is None:
            out.append(Finding(NAME, 'WARN', f'{label}: the face landmark reader is not available, so the held frame is not measured', start, data={'not_measured': True}))
            continue
        faces = next((got[p] for p in images if got.get(p)), None)
        if not faces:
            out.append(Finding(NAME, 'WARN', f'{label}: no face found on the held frame, so the eyes are not measured', start, data={'not_measured': True}))
            continue
        f = max(faces, key=lambda x: x['box'][2] * x['box'][3])
        eyes = [e for e in f['eye_open'] if e is not None]
        if not eyes:
            out.append(Finding(NAME, 'WARN', f'{label}: the eyes were not found on the held frame, so they are not measured', start, data={'not_measured': True}))
            continue
        eye, mouth = min(eyes), f.get('mouth_open')
        data = {'eye_open': eye, 'mouth_open': mouth, 'hold_s': secs}
        bad = False
        if secs >= c['min_hold_s'] and eye < c['eye_open_min']:
            bad = True
            out.append(Finding(NAME, 'FAIL', f'{label}: the eyes are {eye:.2f} open on the held frame (needs {c["eye_open_min"]} or more; open eyes read {c["open_reference"]} and over): '
                               'the picture freezes on a blink or half-closed eyes; hold a frame with the eyes open', start, start + secs, data))
        if secs >= c['mouth_min_hold_s'] and mouth is not None and mouth >= c['mouth_open_warn']:
            bad = True
            out.append(Finding(NAME, 'WARN', f'{label}: the mouth is {mouth:.2f} open on the held frame ({c["mouth_open_warn"]} or more reads mid-word) for {secs:.1f}s; a frame with the mouth closed or at rest holds better', start, start + secs, data))
        if not bad:
            out.append(Finding(NAME, 'INFO', f'{label}: eyes {eye:.2f} open (needs {c["eye_open_min"]}), mouth {mouth if mouth is None else round(mouth, 2)}', start, data=data))
    return out
