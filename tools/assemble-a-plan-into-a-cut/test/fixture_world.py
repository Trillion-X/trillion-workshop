"""A made-up world for the tests: recordings drawn by ffmpeg (test patterns and tones), word lists counted out, plans, a piece
table, devices for a stand-in renderer, and the request that ties them together. Nothing here comes from a real film or person."""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIX = HERE / 'fixtures'
TOOL = HERE.parent
PY = sys.executable

NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *args], check=True)


def counted_words(seconds, step=0.4, sentence=5):
    """a made-up word every step seconds, a full stop after every sentence words, a pause after each stop"""
    words, t, n = [], 0.2, 0
    while t + 0.3 < seconds:
        n += 1
        text = NUMBERS[(n - 1) % len(NUMBERS)] + ('.' if n % sentence == 0 else '')
        words.append({'text': text, 'start': round(t, 3), 'end': round(t + 0.28, 3)})
        t += step + (0.5 if n % sentence == 0 else 0)
    return words


def make_world(root):
    root = Path(root)
    media, words, plans, voice = root / 'media', root / 'words', root / 'plans', root / 'voice'
    for d in (media, words, plans, voice):
        d.mkdir(parents=True, exist_ok=True)
    clips = {'take-one': ('testsrc2', 12, 300), 'take-two': ('smptebars', 10, 500)}
    for name, (pattern, secs, hz) in clips.items():
        ffmpeg('-f', 'lavfi', '-i', f'{pattern}=size=640x360:rate=24000/1001:duration={secs}', '-f', 'lavfi', '-i', f'sine=frequency={hz}:duration={secs}:sample_rate=48000',
               '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(media / f'{name}.mp4'))
        (words / f'{name}.words.json').write_text(json.dumps({'source': str(media / f'{name}.mp4'), 'words': counted_words(secs)}))
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=400:duration=8:sample_rate=48000', str(media / 'memo.wav'))
    (words / 'memo.words.json').write_text(json.dumps({'source': str(media / 'memo.wav'), 'words': counted_words(8)}))
    chain = {'slug': 'chain-fixture', 'id': 'F1', 'title': 'A made-up chain', 'format': {'option': 'chain', 'medium': 'film'},
             'segments': [
                 {'kind': 'opening', 'clip': 'take-one', 'from': 1.0, 'to': 2.9, 'text': 'two three four five.'},
                 {'kind': 'ask', 'clip': None, 'from': None, 'to': None, 'text': 'What is the made-up question?'},
                 {'kind': 'reply', 'clip': 'take-two', 'from': 0.6, 'to': 2.7, 'text': 'three four five. six seven', 'label': '1'},
                 {'kind': 'reply', 'clip': 'take-two', 'from': 3.6, 'to': 5.2, 'text': 'nine ten. one two'},
                 {'kind': 'reply', 'clip': 'memo', 'from': 0.2, 'to': 2.6, 'text': 'one two three four five.'},
                 {'kind': 'note', 'clip': None, 'from': None, 'to': None, 'text': 'not cut'}]}
    deck = {'slug': 'deck-fixture', 'id': 'F2', 'title': 'A made-up deck', 'basis': 'given, kept', 'byline': 'A. Maker', 'format': {'option': 'deck', 'medium': 'deck'},
            'segments': [{'kind': 'page', 'text': 'A made-up deck'}, {'kind': 'page', 'text': 'First made-up page.'}, {'kind': 'page', 'text': 'Second made-up page.'}]}
    other = {'slug': 'other-fixture', 'id': 'F3', 'title': 'A made-up other', 'format': {'option': 'unknown-format', 'medium': 'film'},
             'segments': [{'kind': 'reply', 'clip': 'take-one', 'from': 1.0, 'to': 2.0, 'text': 'x'}]}
    for p in (chain, deck, other):
        (plans / f"{p['slug']}.json").write_text(json.dumps(p, indent=1))
    return {'root': root, 'plans': plans, 'voice': voice, 'words': words, 'media': media}


def fake_renderer_row():
    def at(*parts):
        return {'join': [{'fill': 'folder'}, *parts]}
    frame = [{'fill': 'width'}, {'fill': 'height'}]
    return {
        'argv': [PY, str(FIX / 'fake_renderer.py'), at('/specs/', {'fill': 'id'}, '.json'), at('/out/', {'fill': 'id'})],
        'stills_argv': ['--stills', {'each': 'stills'}],
        'spec_file': at('/specs/', {'fill': 'id'}, '.json'),
        'out_folder': at('/out/', {'fill': 'id'}),
        'id_mark': 't',
        'outputs': {'overlay': 'overlay.mov', 'sound': 'sound.wav', 'timeline': 'timeline.json'},
        'time_fields': {'keys': ['at', 'out'], 'suffix': '_at', 'lists': ['times']},
        'id_fields': {'id': 'id', 'refs': ['targets']},
        'exit_s': 1.0,
        'specs': {
            'segment': {'id': {'fill': 'id'}, 'frame': frame, 'duration_s': {'fill': 'duration'}, 'events': {'fill': 'events'}},
            'cut': {'id': {'fill': 'id'}, 'frame': frame, 'cut': {'fill': 'cut'}, 'plan': {'fill': 'plan'}, 'duration_s': {'fill': 'duration'},
                    'overlay_file': {'fill': 'overlay_file'}, 'aspects': {'fill': 'aspects'},
                    'voice': {'if': 'voice_words', 'then': {'words': {'fill': 'voice_words'}}}, 'spoken': {'words': {'fill': 'spoken_words'}},
                    'events': {'fill': 'events'}},
            'measure': {'id': {'fill': 'id'}, 'frame': frame, 'duration_s': {'fill': 'duration'}, 'events': {'fill': 'events'}},
            'slide': {'id': {'fill': 'id'}, 'frame': frame, 'duration_s': 0.05, 'fill_colour': [200, 190, 170], 'events': {'fill': 'events'}}},
        'cut_spec_merge': {'notes': 'same', 'moves': 'last', 'purpose': 'join'}}


def devices():
    tag_event = {'type': 'tag', 'id': {'fill': 'id'}, 'words': {'fill': 'words'}, 'pos': [{'fill': 'x'}, {'fill': 'y'}],
                 'lean': {'by_side': {'left': -1, 'right': 1}}, 'at': {'fill': 'at'}, 'out': {'fill': 'out'}, 'why': 'a note that never reaches the renderer'}
    block = {'font': 'pillow-default', 'sizes': [28, 22], 'wrap_width': 260, 'line_height': 1.1, 'inset': {'left': 10, 'right': 10}, 'bottom_room': 10}
    return {
        'safe_margin_px': 12,
        'tag': {'measure': {'font': 'pillow-default', 'size': 14, 'pad_em': 2}, 'y': 10, 'height_em': 2, 'inset': {'left': 6, 'right': 6}, 'event': tag_event},
        'label': {'text': {'join': ['Part ', {'fill': 'label'}]}, 'measure': {'font': 'pillow-default', 'size': 16, 'pad_em': 1}, 'height_em': 2,
                  'inset': {'left': 6, 'right': 10}, 'gap_below_tag': 8, 'at': 0.15, 'hold_s': 1.5, 'min_hold_s': 0.5, 'end_room_s': 0.3, 'exit_s': 0.4,
                  'events': [{'type': 'label', 'id': 'part', 'text': {'fill': 'text'}, 'pos': [{'fill': 'x'}, {'fill': 'y'}], 'at': {'fill': 'at'}},
                             {'type': 'leave', 'targets': ['part'], 'at': {'fill': 'out'}}]},
        'recreated': {'words': 'made-up voice notice', 'tag_id': 'made', 'at': 0.1, 'leaves_before_end_s': 0.3},
        'recorded': {'heights': [80, 160], 'probe_room_s': 0.5, 'tail_s': 0.2, 'spec': {'notes': {'leave': 2}, 'purpose': 'a made-up purpose'},
                     'spec_with_plan_graphics': {'moves': {'enter': 'made-up move'}}},
        'voiced_line': {'default_style': 'lit', 'tag_id': 'asker', 'tag_at': 0.1, 'out_before_end_s': 0.1, 'tag_leaves_s': 0.3, 'text_bottom_share': 0.9,
                        'spec': {'hold': {'seconds': {'fill': 'hold_s'}}, 'notes': {'drop': 1}},
                        'styles': {
                            'lit': {'top_gap': 12, 'block': block, 'backing': {'pad': [8, 6, 8, 6], 'at': 0.1, 'after_out_s': 0.2}, 'tail_s': 0.6,
                                    'events': [{'use': 'backing'},
                                               {'type': 'words', 'id': 'q', 'text': {'fill': 'text'}, 'size': {'fill': 'size'}, 'times': {'fill': 'times'}, 'out': {'fill': 'out'},
                                                'on_side': {'left': {'pos': [{'fill': 'x0'}, {'fill': 'top'}]}, 'right': {'right': {'fill': 'x1'}, 'top': {'fill': 'top'}}}},
                                               {'use': 'tag'}]},
                            'card': {'top_gap': 12, 'block': {'wrap_chars': 20, 'sizes': [20]}, 'tag_side': 'left', 'tail_s': 1.0,
                                     'events': [{'use': 'tag'}, {'type': 'card', 'id': 'q', 'text': {'fill': 'text'}, 'at': 0.1, 'out': {'fill': 'out'}}]}}},
        'caption': {'font': 'pillow-default', 'size': 18, 'center_y': 300, 'wrap_width': 500, 'line_height': 1.1, 'fade_s': 0.2, 'min_up_s': 0.3,
                    'out_room_s': 0.04, 'strip_end': ',;', 'tail_s': 0.3, 'backing_pad': [10, 6, 10, 6],
                    'chunk': {'aim_words': 4, 'min_words': 2, 'min_s': 0.5, 'max_words': 6, 'dangling_words': ['and'], 'clause_words': ['if'], 'stops': '.?!', 'commas': ',;:',
                              'cost': {'after_stop': 0, 'after_comma': 1, 'before_clause': 2, 'elsewhere': 5, 'after_dangling': 100, 'per_word_off_aim': 0.1, 'short': 50}},
                    'event': {'type': 'caption', 'id': {'fill': 'id'}, 'text': {'fill': 'text'}, 'center': {'fill': 'center'}, 'at': {'fill': 'ready_at'},
                              'times': {'fill': 'times'}, 'out': {'fill': 'out'}}},
        'backing': {'contrast': 6.0, 'percentile': 98, 'alpha': [0.5, 0.9],
                    'event': {'type': 'backing', 'id': 'bk', 'box': {'fill': 'box'}, 'alpha': {'fill': 'alpha'}, 'at': {'fill': 'at'}, 'out': {'fill': 'out'}}},
        'plan_graphics': {'times': {'key': 'times', 'value': 'source'}, 'notes': ['times', 'why'], 'position_key': 'pos', 'mirror_keys': ['enter'],
                          'mirror': {'left': 'right', 'right': 'left'}},
        'stand_in': {'push': 0.04},
        'slide': {'event': {'type': 'page', 'id': 'page', 'text': {'fill': 'text'}, 'label': {'fill': 'label'}, 'cover': {'fill': 'cover'},
                            'fit_with': {'if': 'fit_with', 'then': {'fill': 'fit_with'}}, 'backdrop': {'fill': 'backdrop'}, 'rot': {'fill': 'rot'}},
                  'rotations': [-1.0, 1.0]}}


def pieces():
    return {'aspects_by_medium': {'film': ['16:9 640x360'], 'deck': ['4:5 400x500']},
            'default': {'opening': {'piece': 'clip'}, 'reply': {'piece': 'clip'}, 'ask': {'piece': 'voiced_line', 'tag': 'made-up tag'},
                        'note': {'piece': 'skip', 'why': 'made-up'}},
            'formats': {'chain': {}, 'deck': {'page': {'piece': 'slide', 'label_from': 'byline', 'backdrop': 'plain',
                                                        'cover': {'from': 'title', 'when': {'field': 'basis', 'matches': '^given'}}}}}}


def request(world, face_x=40, checks=None):
    root = world['root']
    return {
        'pieces': pieces(),
        'plans': {'folder': str(world['plans'])},
        'clips': {'words_folder': str(world['words'])},
        'looks': {'chains': {'warm': [{'filter': 'eq', 'options': {'saturation': 1.1}}]}, 'by_clip': {'take-two': 'warm'}},
        'voice': {'folder': str(world['voice']), 'say': [{'argv': [PY, str(FIX / 'fake_speaker.py'), {'fill': 'text_file'}, {'fill': 'out'}]}]},
        'face_reader': {'argv': [PY, str(FIX / 'fake_face_reader.py'), str(face_x)]},
        'overlay_renderer': fake_renderer_row(),
        'devices': devices(),
        'checks': checks if checks is not None else [
            {'id': 'first-check', 'argv': [PY, str(FIX / 'fake_checker.py'), '0', 'all fine', {'fill': 'cut'}, {'fill': 'report'}]}],
        'folders': {'work': str(root / 'work'), 'seen': str(root / 'seen'), 'specs': str(root / 'specs'), 'holds_log': str(root / 'seen' / 'holds.json')},
        'refs': {'cut_relative_to': str(root), 'plan_relative_to': str(root)},
    }


def run_tool(step, req, *slugs, cwd=None):
    """the tool's CLI on a request written to a file; (exit code, last-line JSON)"""
    path = Path(req['folders']['work']).parent / f'request-{step}.json'
    path.write_text(json.dumps(req))
    r = subprocess.run([PY, str(TOOL / 'do-work' / 'assemble.py'), step, '--request', str(path), *slugs], capture_output=True, text=True, cwd=cwd)
    return r.returncode, json.loads(r.stdout.strip().splitlines()[-1])
