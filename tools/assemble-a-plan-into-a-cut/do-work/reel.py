"""The string-together step: made cuts in the order given, one plain text card between each two, into one reel, and the time each
cut starts at.

request: {"films": [{"file", "label", "card_text"}], "card": {"seconds", "font"?, "size", "wrap_chars", "line_step", "colour",
          "text_colour", "border_px", "noise_amplitude"}, "work": a folder for the reel's pieces, "out": reel file, "index": optional text file}
The card before a film shows that film's card_text over a soft brown-noise room tone. A film whose file does not exist is listed as
missing and left out. The reel is one media-composition edit (the films as clips, the cards as card segments) at the first film's
frame size and rate, rendered by render-an-edit.
"""
import textwrap
from pathlib import Path

import media
from fill import Refused


def clock(t):
    return f'{int(t // 60)}:{t % 60:04.1f}'


def picture_of(path):
    s = next(x for x in media.stream_kinds(path)['streams'] if x['codec_type'] == 'video')
    return s['width'], s['height'], s['r_frame_rate']


def card(k, text, c):
    """the card segment that shows text: wrapped at wrap_chars, lines line_step of the size apart, centred"""
    line = {'size': c['size'], 'color': c['text_colour'], 'gap': c['line_step'] - 1, 'border_px': c['border_px'], 'border_color': 'black@0.6'}
    if c.get('font'):
        line['font_file'] = str(c['font'])
    return {'id': f'card{k:02d}', 'kind': 'card', 'duration': c['seconds'], 'bg': c['colour'],
            'lines': [{**line, 'text': t} for t in textwrap.wrap(text, c['wrap_chars'])],
            'audio_source': f"anoisesrc=color=brown:amplitude={c['noise_amplitude']}:r=48000"}


def string_together(req):
    films = [f for f in req['films'] if Path(f['file']).is_file()]
    missing = [f['file'] for f in req['films'] if not Path(f['file']).is_file()]
    if not films:
        raise Refused('none of the films is a file')
    out = Path(req['out'])
    w, h, rate = picture_of(films[0]['file'])
    segments, index, t = [], [], 0.0
    for k, f in enumerate(films):
        if segments:
            segments.append(card(k, f['card_text'], req['card']))
            t += req['card']['seconds']
        dur = media.probe_dur(f['file'])
        index.append({'start': round(t, 2), 'clock': clock(t), 'label': f['label'], 'seconds': round(dur, 1)})
        segments.append({'id': f'film{k:02d}', 'kind': 'clip', 'source': str(f['file'])})
        t += dur
    out.parent.mkdir(parents=True, exist_ok=True)
    media.render({'encode': {'width': w, 'height': h, 'fps': rate, 'crf': 18, 'preset': 'veryfast', 'audio_bitrate': '192k'},
                  'spine': {'segments': segments}}, out, Path(req['work']))
    Path(f'{out}.result.json').unlink(missing_ok=True)
    if req.get('index'):
        Path(req['index']).write_text(''.join(f"{r['clock']}  {r['start']:.2f}s  {r['label']}  ({r['seconds']:.1f}s)\n" for r in index))
    return {'reel': str(out), 'seconds': round(media.probe_dur(out), 1), 'films': index, 'missing': missing}
