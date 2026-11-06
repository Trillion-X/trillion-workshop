#!/usr/bin/env python3
# tools/put-picked-options-into-a-filmcraft-project/do-work/review_pack.py
"""The input of a fresh-viewer review (the fresh-viewer prompt of the Workshop's tools/check-a-rendered-video review-pack) for one preview
(the option's working preview unless the request names `video`): work-round-<n>/review-pack/<id>/ with contact sheets
(settings review_pack: a frame every every_s seconds, per_sheet tiles a sheet, width px, made by tools/make-a-contact-sheet-of-pictures-or-video-frames),
transcript.txt (tools/audio-transcription whisper_here, model and language from the settings, a line per sentence with mm:ss) and
rules.txt (kept from the pack that is there).
Request: film, option, video?, chapter?, options_folder?, settings_record?, settings?. Answer: {"result": {"pack", "sheets", "tiles", "lines"}}."""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import option_folders as place  # noqa: E402
TOOLS = os.path.dirname(os.path.dirname(HERE))
SHEET = os.path.join(TOOLS, 'make-a-contact-sheet-of-pictures-or-video-frames', 'do-work', 'frames_at_times.py')
sys.path.insert(1, os.path.join(TOOLS, 'audio-transcription', 'do-work'))  # whisper_here, packed at /opt/audio-transcription


def main(req):
    place.configure(req)
    oid = req['option']
    RP = place.PLACE['review_pack']
    WR = place.rdir('work', oid)
    video = os.path.join(WR, 'working', oid + '.mp4')
    video = os.path.expanduser(req.get('video') or video)
    if not os.path.exists(video):
        raise SystemExit(f'{oid}: no preview at {video}; make the working preview first, or give video')
    pack = os.path.join(WR, 'review-pack', oid)
    os.makedirs(pack, exist_ok=True)
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], capture_output=True, text=True).stdout)
    for f in os.listdir(pack):
        if f.startswith('sheet-'):
            os.remove(os.path.join(pack, f))
    step, per = RP['every_s'], RP['per_sheet']
    times = [str(t) for t in range(int(dur) + 1)]
    if step != 1:
        times = [f'{k * step:g}' for k in range(int(dur / step) + 1)]
    sheets = []
    for k in range(0, len(times), per):
        sheets.append(os.path.join(pack, 'sheet-%02d.jpg' % (k // per + 1)))
        subprocess.run([sys.executable, SHEET, sheets[-1], video] + times[k:k + per] + ['--width', str(RP['width'])], check=True, stdout=sys.stderr)
    os.makedirs(os.path.join(WR, 'working'), exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='rp-', dir=os.path.join(WR, 'working'))
    wav = os.path.join(tmp, 'a.wav')
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', wav], check=True)
    import whisper_here  # tools/audio-transcription: mlx_whisper where the place has it, else faster-whisper or openai-whisper
    res = whisper_here.transcribe(wav, path_or_hf_repo=RP['model'], word_timestamps=True, language=RP['language'])
    said = [w for s in res['segments'] for w in s['words']]
    json.dump({'words': [{'text': w['word'].strip(), 'start': w['start'], 'end': w['end']} for w in said]}, open(os.path.join(tmp, 'w.json'), 'w'), indent=1)
    words = json.load(open(os.path.join(tmp, 'w.json')))['words']
    lines = transcript_lines(words)
    open(os.path.join(pack, 'transcript.txt'), 'w').write('\n'.join(lines) + '\n')
    print(pack, len(times), 'tiles;', len(lines), 'lines;', tmp)
    return {'pack': pack, 'sheets': sheets, 'tiles': len(times), 'lines': len(lines), 'scratch': tmp}


def transcript_lines(words):
    """A line per sentence (a word ending in . ? or !), each led by the mm:ss of its first word."""
    lines, cur, t0 = [], [], None
    for w in words:
        if t0 is None:
            t0 = w['start']
        cur.append(w['text'])
        if w['text'].endswith(('.', '?', '!')):
            lines.append('%02d:%02d %s' % (int(t0) // 60, int(t0) % 60, ' '.join(cur)))
            cur, t0 = [], None
    if cur:
        lines.append('%02d:%02d %s' % (int(t0) // 60, int(t0) % 60, ' '.join(cur)))
    return lines


if __name__ == '__main__':
    place.answer(main)
