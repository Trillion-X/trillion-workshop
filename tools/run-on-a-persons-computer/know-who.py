# computer/know-who.py
#
# Purpose: names who is in a recording or a picture on this computer, against the people enrolled on it. Voices are
# matched with the WeSpeaker ResNet34 voice model (pyannote/wespeaker-voxceleb-resnet34-LM, 256 numbers a voice);
# faces with SCRFD to find them and ArcFace (buffalo_l w600k_r50, 512 numbers a face) to tell them apart, the same
# models the earlier intake identity worker used (architect-societies/intake-desktop worker_identity.py), here run
# through onnxruntime and cv2 alone so a broken image library elsewhere never stops it. It is the `know_who` program of
# computer/computer-sources.json's listening row and of the Mac tools in computer/mac-tools.json.
#
#   python3 know-who.py people  <settings json> <people folder>
#   python3 know-who.py voices  <settings json> <people folder> <recording> <spans json file> [<session file>]
#   python3 know-who.py faces   <settings json> <people folder> <picture or video>
#   python3 know-who.py enroll  <settings json> <people folder> <name> <voice|face> <file> <consent words> [--me]
#   python3 know-who.py enroll  <settings json> <people folder> <name> voice - <consent words> --from-unknown <voice id> <session file>
#
#   python3 know-who.py serve   <socket> <idle_seconds>
#       stays running with its models loaded (computer/resident.py) and answers { "argv": [<this file>, <command>,
#       ...] } with { "ok": true, "value": <the same answer> }, so naming the voices of a piece every half minute loads
#       the voice model once. The know_who row's `resident` (computer-sources.json) says its socket.
#
# Every answer is one JSON value on stdout.
#   voices -> [{ start, end, who: { id, name, me } | null, score, voice }]   voice is a person's id, or "voice-N", the
#             same N for the same unknown voice across every piece of one listening session (the session file).
#   faces  -> [{ at, box: [x1, y1, x2, y2], who | null, score, found }]
#   enroll -> { id, name, me, voice_samples, face_samples, picture, consent, heard_as? }   heard_as: every voice-N label
#             a voice enrolled from a listening was heard under (it and the voices merged into it).
#   people -> [{ id, name, me, voice_samples, face_samples, picture, consent }]
#
# Invariants:
#   1. Nothing leaves this computer. A person's voice and face numbers are kept only in the people folder
#      (one <id>.json each, their picture beside it as <id>.jpg), readable by this user alone.
#   2. Nobody is named without being enrolled, and nobody is enrolled without consent words saying who agreed and how;
#      an enrollment without them is refused. Everyone else stays an unnamed voice.
#   3. Thresholds are DATA (the settings json): how alike a voice or face must be to count as a person, how alike two
#      unknown voices must be to be the same voice, the shortest stretch worth measuring, how long a voice must speak
#      before it counts as a new voice. Stretches of one piece are grouped by voice and judged together, and two
#      session voices that grow alike merge (the survivor lists the other in `also`), so a room of three people reads
#      as about three voices, never one per sentence.
#   4. A recording is read in place; only the people folder (on enroll) and the session file are written.
#
# AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import json
import os
import re
import subprocess
import sys

import numpy as np

SAMPLE_RATE = 16000


LOADED = {}


def loaded(kind, make):
    """A model made once per process: a resident (serve) keeps it for every request after the first."""
    if kind not in LOADED:
        LOADED[kind] = make()
    return LOADED[kind]


def say(value):
    json.dump(value, sys.stdout)
    sys.stdout.write('\n')


def unit(vector):
    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 0 else vector


def alike(a, b):
    return float(np.dot(unit(a), unit(b)))


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'person'


def people_in(folder):
    found = []
    if not os.path.isdir(folder):
        return found
    for name in sorted(os.listdir(folder)):
        if name.endswith('.json'):
            with open(os.path.join(folder, name)) as handle:
                found.append(json.load(handle))
    return found


def keep_file(path, write):
    with open(path + '.part', 'w') as handle:
        write(handle)
    os.chmod(path + '.part', 0o600)
    os.replace(path + '.part', path)


def keep_person(folder, person):
    os.makedirs(folder, mode=0o700, exist_ok=True)
    keep_file(os.path.join(folder, person['id'] + '.json'), lambda handle: json.dump(person, handle))


def summary(person):
    return {
        'id': person['id'], 'name': person['name'], 'me': bool(person.get('me')),
        'voice_samples': len(person.get('voice', [])), 'face_samples': len(person.get('face', [])),
        'picture': person.get('picture'), 'consent': person.get('consent', []),
    }


def best_of(vector, people, kind, rules):
    """Who a vector is: (who, score, unsure). Named only when the best person reaches `person_at_least` AND no other
    person is within `sure_by` of them; otherwise the people it could be (the best, and anyone within `sure_by`, at
    `maybe_at_least` or more) come back as `unsure`, so a guess is never made silently."""
    ranked = sorted(((max((alike(vector, sample) for sample in person.get(kind, [])), default=-1.0), person) for person in people),
                    key=lambda pair: pair[0], reverse=True)
    if not ranked:
        return None, -1.0, []
    score, best = ranked[0]
    close = [person for value, person in ranked[1:] if score - value < rules.get('sure_by', 0)]
    if score >= rules['person_at_least'] and not close:
        return {'id': best['id'], 'name': best['name'], 'me': bool(best.get('me'))}, score, []
    maybe = [best] + close if score >= rules.get('maybe_at_least', rules['person_at_least']) else []
    return None, score, [{'id': person['id'], 'name': person['name']} for person in maybe]


# ---- Voices -------------------------------------------------------------------------------------------------------

def sound_of(recording):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', recording, '-f', 'f32le', '-ac', '1', '-ar', str(SAMPLE_RATE), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


class Voices:
    def __init__(self):
        os.environ.setdefault('HF_HUB_OFFLINE', '1')
        import warnings
        warnings.filterwarnings('ignore')
        import torch
        from pyannote.audio import Inference, Model
        self.torch = torch
        self.inference = Inference(Model.from_pretrained('pyannote/wespeaker-voxceleb-resnet34-LM'), window='whole')

    def of(self, samples):
        waveform = self.torch.from_numpy(np.ascontiguousarray(samples)).unsqueeze(0)
        return unit(self.inference({'waveform': waveform, 'sample_rate': SAMPLE_RATE}))


def read_session(path):
    if path and os.path.exists(path):
        with open(path) as handle:
            return json.load(handle)
    return {'unknown': []}


def voice_of(session, voice_id):
    """The session voice an id names: itself, or the voice it was merged into (its `also`)."""
    return next((voice for voice in session['unknown'] if voice['id'] == voice_id or voice_id in voice.get('also', [])), None)


def join_voice(voice, vector, seconds):
    """Adds speech to a session voice: its numbers are a running mean weighted by seconds heard."""
    heard = voice.get('seconds', voice.get('count', 1))
    voice['mean'] = unit((np.asarray(voice['mean']) * heard + np.asarray(vector) * seconds) / (heard + seconds)).tolist()
    voice['seconds'] = heard + seconds
    voice['count'] = voice.get('count', 1) + 1


def merge_alike(session, at_least):
    """Two session voices that have become as alike as one voice are one voice: the older keeps its id and lists the
    other in `also`, so turns already sent under either label can be named together later."""
    merged = True
    while merged:
        merged = False
        voices = session['unknown']
        for first in range(len(voices)):
            for second in range(first + 1, len(voices)):
                if alike(voices[first]['mean'], voices[second]['mean']) >= at_least:
                    keep, gone = voices[first], voices.pop(second)
                    join_voice(keep, gone['mean'], gone.get('seconds', gone.get('count', 1)))
                    keep['also'] = keep.get('also', []) + [gone['id']] + gone.get('also', [])
                    merged = True
                    break
            if merged:
                break


def groups_of(vectors, at_least):
    """Stretches of one piece that sound like one voice, grouped before any is named, so a voice is judged on all it
    said in the piece rather than on one short stretch: each stretch joins the group whose pooled numbers it is most
    like when at `at_least` or more, else starts a group."""
    groups = []
    for index, vector in enumerate(vectors):
        best, best_score = None, -1.0
        for group in groups:
            value = alike(vector, group['mean'])
            if value > best_score:
                best, best_score = group, value
        if best is not None and best_score >= at_least:
            best['members'].append(index)
            best['mean'] = unit(np.sum([vectors[at] for at in best['members']], axis=0))
        else:
            groups.append({'members': [index], 'mean': vector})
    return groups


def voices(settings, folder, recording, spans, session_path=None):
    rules = settings['voices']
    same = rules['same_unknown_at_least']
    in_piece = rules.get('same_in_piece_at_least', same)
    new_voice_seconds = rules.get('new_voice_shortest_seconds', 0)
    people = [person for person in people_in(folder) if person.get('voice')]
    session = read_session(session_path)
    sound = sound_of(recording)
    model = loaded('voices', Voices)
    answers = [{'start': float(span['start']), 'end': float(span['end']), 'who': None, 'score': None, 'voice': None, 'unsure': []} for span in spans]
    measured = [at for at, answer in enumerate(answers) if answer['end'] - answer['start'] >= rules['shortest_seconds']]
    pieces = {at: sound[int(answers[at]['start'] * SAMPLE_RATE):int(answers[at]['end'] * SAMPLE_RATE)] for at in measured}
    measured = [at for at in measured if len(pieces[at]) >= rules['shortest_seconds'] * SAMPLE_RATE]
    vectors = [model.of(pieces[at]) for at in measured]
    for group in groups_of(vectors, in_piece):
        members = [measured[at] for at in group['members']]
        seconds = sum(answers[at]['end'] - answers[at]['start'] for at in members)
        # The group's own numbers, from all it said in this piece together.
        vector = model.of(np.concatenate([pieces[at] for at in members])) if len(members) > 1 else vectors[group['members'][0]]
        who, score, unsure = best_of(vector, people, 'voice', rules)
        if who:
            for at in members:
                answers[at].update(who=who, score=round(score, 3), voice=who['id'], unsure=[])
            continue
        # An unknown voice: the session's own voice it is most like, or a new one. A voice heard too briefly to be
        # told apart from the rest (new_voice_shortest_seconds) never starts a voice of its own: it joins the voice it
        # is most like when that is at least maybe_at_least, else takes its neighbour's voice below.
        best, best_score = None, -1.0
        for voice in session['unknown']:
            value = alike(vector, voice['mean'])
            if value > best_score:
                best, best_score = voice, value
        if best is not None and best_score >= same:
            join_voice(best, vector, seconds)
        elif seconds >= new_voice_seconds:
            best = {'id': 'voice-%d' % (session.get('made', len(session['unknown'])) + 1), 'mean': vector.tolist(), 'count': 1, 'seconds': seconds}
            session['made'] = session.get('made', len(session['unknown'])) + 1
            session['unknown'].append(best)
        elif best is None or best_score < rules.get('maybe_at_least', same):
            continue
        for at in members:
            answers[at].update(score=round(score, 3), voice=best['id'], unsure=unsure)
    merge_alike(session, same)
    for answer in answers:
        if answer['voice'] and not answer['who']:
            answer['voice'] = voice_of(session, answer['voice'])['id']
    if session_path:
        keep_file(session_path, lambda handle: json.dump(session, handle))
    # A stretch too short to measure takes the voice of the nearest named stretch before it, else after it.
    for index, answer in enumerate(answers):
        if answer['voice'] is None:
            order = list(range(index - 1, -1, -1)) + list(range(index + 1, len(answers)))
            near = next((answers[at] for at in order if answers[at]['voice'] and answers[at]['score'] is not None), None)
            if near:
                answer.update(who=near['who'], voice=near['voice'], unsure=near['unsure'])
    return answers


# ---- Faces --------------------------------------------------------------------------------------------------------

ARCFACE_POINTS = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


class Faces:
    def __init__(self, models):
        import cv2
        import onnxruntime
        self.cv2 = cv2
        folder = os.path.expanduser(models)
        self.find = onnxruntime.InferenceSession(os.path.join(folder, 'det_10g.onnx'), providers=['CPUExecutionProvider'])
        self.tell = onnxruntime.InferenceSession(os.path.join(folder, 'w600k_r50.onnx'), providers=['CPUExecutionProvider'])

    def found(self, image, at_least, size=640):
        cv2 = self.cv2
        height, width = image.shape[:2]
        scale = min(size / width, size / height)
        resized = cv2.resize(image, (max(1, int(width * scale)), max(1, int(height * scale))))
        canvas = np.zeros((size, size, 3), dtype=np.uint8)
        canvas[:resized.shape[0], :resized.shape[1]] = resized
        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128.0, (size, size), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.find.run(None, {self.find.get_inputs()[0].name: blob})
        boxes, scores, points = [], [], []
        for index, stride in enumerate((8, 16, 32)):
            score = outs[index].reshape(-1)
            box = outs[index + 3].reshape(-1, 4) * stride
            kps = outs[index + 6].reshape(-1, 10) * stride
            cells = size // stride
            centers = np.stack(np.mgrid[:cells, :cells][::-1], axis=-1).astype(np.float32).reshape(-1, 2) * stride
            centers = np.repeat(centers, 2, axis=0)
            for at in np.where(score >= at_least)[0]:
                cx, cy = centers[at]
                boxes.append([cx - box[at][0], cy - box[at][1], cx + box[at][2], cy + box[at][3]])
                scores.append(float(score[at]))
                points.append([[cx + kps[at][2 * k], cy + kps[at][2 * k + 1]] for k in range(5)])
        if not boxes:
            return []
        boxes = np.array(boxes) / scale
        points = np.array(points) / scale
        kept = cv2.dnn.NMSBoxes([[float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])] for b in boxes], scores, at_least, 0.4)
        return [(boxes[i], points[i], scores[i]) for i in np.array(kept).reshape(-1)]

    def of(self, image, points):
        cv2 = self.cv2
        matrix, _ = cv2.estimateAffinePartial2D(points.astype(np.float32), ARCFACE_POINTS, method=cv2.LMEDS)
        face = cv2.warpAffine(image, matrix, (112, 112), borderValue=0.0)
        blob = cv2.dnn.blobFromImage(face, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        return unit(self.tell.run(None, {self.tell.get_inputs()[0].name: blob})[0])


def pictures_of(path, every_seconds):
    import cv2
    image = cv2.imread(path)
    if image is not None:
        return [(0.0, image)]
    video = cv2.VideoCapture(path)
    rate = video.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, int(rate * every_seconds))
    frames, at = [], 0
    while True:
        ok, frame = video.read()
        if not ok:
            break
        if at % step == 0:
            frames.append((at / rate, frame))
        at += 1
    return frames


def faces(settings, folder, path):
    rules = settings['faces']
    people = [person for person in people_in(folder) if person.get('face')]
    model = loaded(('faces', rules['models']), lambda: Faces(rules['models']))
    answers = []
    for second, image in pictures_of(path, rules['every_seconds']):
        for box, points, found_score in model.found(image, rules['found_at_least']):
            who, score, unsure = best_of(model.of(image, points), people, 'face', rules)
            answers.append({'at': round(second, 2), 'box': [round(float(v), 1) for v in box], 'who': who, 'score': round(score, 3), 'found': round(found_score, 3), 'unsure': unsure})
    return answers


# ---- Enrolling ----------------------------------------------------------------------------------------------------

def enroll(settings, folder, name, kind, path, consent, me=False, from_unknown=None, session_path=None):
    if not consent or not consent.strip():
        raise SystemExit('Say who agreed to be known by their %s here, and how, before enrolling them.' % kind)
    person_id = slug(name)
    heard_as = []
    person = next((person for person in people_in(folder) if person['id'] == person_id), None) or {'id': person_id, 'voice': [], 'face': []}
    person['name'] = name
    if me:
        person['me'] = True
    person.setdefault('consent', []).append({'kind': kind, 'said': consent.strip()})
    if kind == 'voice':
        if from_unknown:
            voice = voice_of(read_session(session_path), from_unknown)
            if voice is None:
                raise SystemExit('No voice %s was heard in that listening.' % from_unknown)
            person['voice'].append(voice['mean'])
            heard_as = [voice['id']] + voice.get('also', [])
        else:
            person['voice'].append(loaded('voices', Voices).of(sound_of(path)).tolist())
    elif kind == 'face':
        rules = settings['faces']
        model = loaded(('faces', rules['models']), lambda: Faces(rules['models']))
        found = [(image, box, points) for _, image in pictures_of(path, rules['every_seconds']) for box, points, _ in model.found(image, rules['found_at_least'])]
        if not found:
            raise SystemExit('No face was found in that picture.')
        # The largest face is the person being enrolled; it is also kept as their picture.
        image, box, points = max(found, key=lambda item: (item[1][2] - item[1][0]) * (item[1][3] - item[1][1]))
        person['face'].append(model.of(image, points).tolist())
        x1, y1, x2, y2 = [int(v) for v in box]
        pad = int(max(x2 - x1, y2 - y1) * 0.35)
        crop = image[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
        os.makedirs(folder, mode=0o700, exist_ok=True)
        picture = os.path.join(folder, person_id + '.jpg')
        model.cv2.imwrite(picture, crop)
        os.chmod(picture, 0o600)
        person['picture'] = picture
    else:
        raise SystemExit('Enroll a voice or a face.')
    keep_person(folder, person)
    return {**summary(person), **({'heard_as': heard_as} if heard_as else {})}


def main(argv):
    command, settings, folder = argv[0], json.loads(argv[1]), os.path.expanduser(argv[2])
    if command == 'people':
        return [summary(person) for person in people_in(folder)]
    if command == 'voices':
        with open(argv[4]) as handle:
            spans = json.load(handle)
        return voices(settings, folder, argv[3], spans, argv[5] if len(argv) > 5 else None)
    if command == 'faces':
        return faces(settings, folder, argv[3])
    if command == 'enroll':
        name, kind, path, consent, rest = argv[3], argv[4], argv[5], argv[6], argv[7:]
        unknown = rest[rest.index('--from-unknown') + 1:rest.index('--from-unknown') + 3] if '--from-unknown' in rest else [None, None]
        return enroll(settings, folder, name, kind, path, consent, '--me' in rest, unknown[0], unknown[1])
    raise SystemExit('Ask know-who.py for people, voices, faces, or to enroll someone.')


if __name__ == '__main__':
    if sys.argv[1] == 'serve':
        from resident import answer_argv, serve
        serve(sys.argv[2], float(sys.argv[3]), answer_argv(main))
    else:
        say(main(sys.argv[1:]))
