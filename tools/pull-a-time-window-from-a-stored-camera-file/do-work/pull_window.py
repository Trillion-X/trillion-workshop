"""Pull only the audio of one time window, or one video frame, from an MP4 kept in cloud storage.

usage: python3 pull_window.py [--base FOLDER] < request.json           one JSON request (below)
       python3 pull_window.py --request <request.json>
       PULL_WINDOW_SETTINGS=<settings.json> python3 pull_window.py <identity> <from> <to> <out.wav>
       PULL_WINDOW_SETTINGS=<settings.json> python3 pull_window.py frame <identity> <second> <out.jpg>
The last two are the film tool's own command line; its store, account and reader are the settings file's.

The camera files run about 13 MB per second of footage and the link here is
about 50 KB/s, so whole-file pulls take hours. Audio is a small part of each
second. This reads the file's box headers and its moov by byte range, builds a
sparse local copy with the same layout, asks ffprobe which byte ranges hold the
audio packets inside [from, to], reads only those ranges, and decodes the audio
from the sparse copy. Video bytes are never fetched. The wav starts with
silence up to <from>, so second N of the wav is second N of the camera file and
plans can cut it in the camera file's seconds.

The request is one JSON object:
  mode        "window" (default): the audio of [from, to] seconds into <out>.wav
              "frame": the keyframe at or before <at> seconds into <out>.jpg, its one packet only
  identity    the stored file's identity as the store names it (a content hash or a file id)
  from, to    window seconds (window mode)          at   the second to take a frame at (frame mode)
  out         where to write the wav or the jpg (a relative path is written in --base, the folder the person let this
              tool change)
What belongs to the person's own storage is their settings: a list:settings row read by
tools/settings/do-work/run-with-settings.mjs (which hands the record in as `settings_record`, read here with
request_settings), or the run's own `settings`; the same key at the top of the request wins:
  store       the store the reader is pointed at
  account     the storage account id the store keeps the file under
  reader      {argv, cwd?, env?, ok_marker?, retries?, retry_seconds?}: the command that reads one byte range of a stored
              file. argv is a template; {store} {account} {identity} {out} {offset} {length} are filled in. It writes the
              bytes to {out} and prints ok_marker (default "ok-range") on success.
  credentials names of environment variables the reader needs (a storage key's name in the person's vault); each must be
              set where this runs. Their values go to the reader and are never read, printed or kept here.
  gap         join audio ranges closer than this many bytes into one read (default 262144)

Moved from a film's tools folder (b2_audio_window.py): the algorithm is unchanged; the reader command, the store and the
account are the person's settings (or the request's), and the frame probe keeps the file's own key flags.
"""
import argparse
import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'settings' / 'read-data'))
from settings import request_settings  # noqa: E402

FOLDER = 'pull-a-time-window-from-a-stored-camera-file'
TOOL = 'tool:pull-a-time-window-from-a-stored-camera-file'
DEFAULT_GAP = 256 * 1024
CONFIG_KEYS = ('store', 'account', 'reader', 'credentials', 'gap')
DEFAULTS = {'store': None, 'account': None, 'reader': None, 'credentials': [], 'gap': DEFAULT_GAP}
GAP = 256 * 1024  # join audio ranges closer than this into one read
READER = None  # the Reader the run is configured with


class Refusal(Exception):
    """A request that cannot be carried out; the message says what to change."""


class Reader:
    """Reads one byte range of a stored file through the person's reader command, counting what it fetched."""

    def __init__(self, request):
        spec = request.get('reader')
        if not isinstance(spec, dict) or not isinstance(spec.get('argv'), list) or not spec['argv']:
            raise Refusal('reader.argv is required: the command (a list of words, with {store} {account} {identity} {out} {offset} {length} where they go) that reads one byte range of a stored file')
        for key in ('store', 'account', 'identity'):
            if not request.get(key):
                raise Refusal(f'{key} is required' + (': the storage account id the file is kept under' if key == 'account' else ''))
        missing = [name for name in request.get('credentials') or [] if name not in os.environ]
        if missing:
            raise Refusal(f'the reader needs {", ".join(missing)} in the environment: set each from the person\'s vault before running this')
        self.spec, self.request = spec, request
        self.cwd = spec.get('cwd') or None
        self.marker = spec.get('ok_marker', 'ok-range')
        self.retries = int(spec.get('retries', 20))
        self.retry_seconds = float(spec.get('retry_seconds', 3))
        self.env = dict(os.environ, **{k: str(v) for k, v in (spec.get('env') or {}).items()})
        self.bytes_fetched = 0
        self.reads = 0

    def read(self, ident, offset, length, tmp):
        out = f'{tmp}/range.bin'
        fill = {'store': self.request['store'], 'account': self.request['account'], 'identity': ident,
                'out': out, 'offset': str(offset), 'length': str(length)}
        for _ in range(self.retries):
            run = subprocess.run([word.format(**fill) for word in self.spec['argv']], cwd=self.cwd, env=self.env, capture_output=True, text=True)
            if run.returncode == 0 and self.marker in run.stdout:
                data = pathlib.Path(out).read_bytes()
                self.bytes_fetched += len(data)
                self.reads += 1
                return data
            time.sleep(self.retry_seconds)
        raise SystemExit(f'range read failed at {offset}+{length}: {run.stdout.strip()} {run.stderr.strip()}')


def read_range(ident, offset, length, tmp):
    return READER.read(ident, offset, length, tmp)


def walk_boxes(ident, tmp):
    """Return [(type, offset, size)] for the top-level boxes up to and including moov."""
    boxes, offset = [], 0
    while True:
        head = read_range(ident, offset, 16, tmp)
        size, kind = struct.unpack('>I4s', head[:8])
        if size == 1:
            size = struct.unpack('>Q', head[8:16])[0]
        boxes.append((kind.decode('latin-1'), offset, size))
        if kind == b'moov':
            return boxes
        if size == 0:
            raise SystemExit('a box runs to the end of the file before any moov')
        offset += size


def sparse_copy(ident, tmp):
    """A local file with the remote file's layout: every top-level box header and the whole moov, media bytes left as holes."""
    boxes = walk_boxes(ident, tmp)
    _, moov_at, moov_size = boxes[-1]
    sparse = f'{tmp}/sparse.mp4'
    with open(sparse, 'wb') as f:
        f.truncate(moov_at + moov_size)
        for kind, at, size in boxes:
            f.seek(at)
            f.write(read_range(ident, at, 16 if kind in ('mdat', 'free') else size, tmp))
    return sparse


def frame(ident, t, out):
    """The keyframe at or before second t, fetched as its one packet and decoded alone: no other video bytes are read."""
    with tempfile.TemporaryDirectory() as tmp:
        sparse = sparse_copy(ident, tmp)
        # +noparse keeps the key flags the file's own sample table gives: the sparse copy holds zeros where the video
        # is, and ffmpeg's H.264 parser would otherwise find no key frame in them and clear every flag.
        probe = subprocess.run(['ffprobe', '-v', 'error', '-fflags', '+noparse+nofillin', '-select_streams', 'v:0', '-read_intervals', f'{max(t - 10, 0):.2f}%{t + 0.1:.2f}',
                                '-show_entries', 'packet=pts_time,pos,size,flags', '-of', 'json', sparse], capture_output=True, text=True, check=True)
        keys = [p for p in json.loads(probe.stdout)['packets'] if 'K' in p.get('flags', '') and p.get('pos') and float(p['pts_time']) <= t + 0.05]
        if not keys:
            raise SystemExit(f'{ident}: no keyframe in the 10 s before {t}')
        key = keys[-1]
        with open(sparse, 'r+b') as f:
            f.seek(int(key['pos']))
            f.write(read_range(ident, int(key['pos']), int(key['size']), tmp))
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-ss', key['pts_time'], '-i', sparse, '-frames:v', '1',
                        '-vf', 'scale=960:-2', out], check=True)
    print(f'{ident} frame at {key["pts_time"]} s (keyframe at or before {t}): {int(key["size"]) / 1e6:.2f} MB -> {out}')
    return {'mode': 'frame', 'identity': ident, 'frame_at': float(key['pts_time']), 'asked_at': t, 'packet_bytes': int(key['size']), 'out': out}


def join_ranges(packets, gap):
    """Sorted (pos, size) packets, joined into [pos, size] reads wherever the gap between two is at most `gap` bytes."""
    ranges = []
    for pos, size in sorted(packets):
        if ranges and pos - (ranges[-1][0] + ranges[-1][1]) <= gap:
            ranges[-1][1] = pos + size - ranges[-1][0]
        else:
            ranges.append([pos, size])
    return ranges


def window(ident, start, end, out):
    """The audio of [start, end], from the audio packets alone (the film tool's main)."""
    with tempfile.TemporaryDirectory() as tmp:
        sparse = sparse_copy(ident, tmp)
        probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-read_intervals',
                                f'{max(start - 1, 0):.2f}%{end + 1:.2f}', '-show_entries', 'packet=pts_time,pos,size',
                                '-of', 'json', sparse], capture_output=True, text=True, check=True)
        packets = [(int(p['pos']), int(p['size'])) for p in json.loads(probe.stdout)['packets'] if p.get('pos')]
        ranges = join_ranges(packets, GAP)
        with open(sparse, 'r+b') as f:
            for pos, size in ranges:
                f.seek(pos)
                f.write(read_range(ident, pos, size, tmp))
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-ss', f'{start:.2f}', '-to', f'{end:.2f}',
                        '-vn', '-i', sparse, '-map', '0:a:0', '-af', f'adelay={round(start * 1000)}:all=1',
                        '-ac', '1', '-ar', '48000', out], check=True)
    fetched = sum(size for _, size in ranges)
    print(f'{ident} {start}-{end}: {len(packets)} audio packets in {len(ranges)} reads, {fetched / 1e6:.1f} MB -> {out}')
    return {'mode': 'window', 'identity': ident, 'from': start, 'to': end, 'audio_packets': len(packets),
            'audio_reads': len(ranges), 'audio_bytes': fetched, 'out': out}


def configured(request):
    """The request with the person's storage settings filled in: defaults < settings row < run settings < top-level keys."""
    settings = request_settings(request, DEFAULTS, folder=FOLDER, tool=TOOL)
    return {**request, **{key: request[key] if key in request else settings[key] for key in CONFIG_KEYS}}


def run(request, base=None):
    """One request: check it, configure the reader and the gap, and run the window or the frame."""
    global READER, GAP
    request = configured(request)
    mode = request.get('mode', 'window')
    out = request.get('out')
    if not out:
        raise Refusal('out is required: where to write the audio (window) or the picture (frame)')
    if base and not pathlib.Path(out).is_absolute():
        out = str(pathlib.Path(base) / out)
    READER, GAP = Reader(request), int(request['gap'])
    if mode == 'frame':
        if not isinstance(request.get('at'), (int, float)):
            raise Refusal('at is required in frame mode: the second to take the frame at')
        answer = frame(request['identity'], float(request['at']), out)
    elif mode != 'window':
        raise Refusal('mode is "window" or "frame"')
    elif not all(isinstance(request.get(k), (int, float)) for k in ('from', 'to')) or request['to'] <= request['from']:
        raise Refusal('from and to are required in window mode: seconds into the file, with to after from')
    else:
        answer = window(request['identity'], float(request['from']), float(request['to']), out)
    answer.update(bytes_fetched=READER.bytes_fetched, reads=READER.reads)
    return answer


def old_command_line():
    """The film tool's command line, its storage read from the settings file PULL_WINDOW_SETTINGS names."""
    global READER
    settings = configured({'settings_record': os.environ['PULL_WINDOW_SETTINGS']})
    if sys.argv[1] == 'frame':
        READER = Reader({**settings, 'identity': sys.argv[2]})
        return frame(sys.argv[2], float(sys.argv[3]), sys.argv[4]) and 0
    ident, start, end, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    READER = Reader({**settings, 'identity': ident})
    return window(ident, start, end, out) and 0


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--request', help='a JSON file holding the request (default: the request on standard input)')
    parser.add_argument('--base', help='the folder a relative out path is written in')
    args = parser.parse_args(argv)
    try:
        request = json.loads(pathlib.Path(args.request).read_text() if args.request else (sys.stdin.read() or '{}'))
        if not isinstance(request, dict):
            raise Refusal('the request must be a JSON object')
        answer = run(request, args.base)
    except (Refusal, SystemExit) as problem:
        print(json.dumps({'error': str(problem.code if isinstance(problem, SystemExit) else problem)}))
        return 1
    except (subprocess.CalledProcessError, OSError, ValueError) as problem:
        print(json.dumps({'error': f'{type(problem).__name__}: {problem}'}))
        return 1
    if request.get('settings_from'):
        answer['settings_from'] = request['settings_from']
    print(json.dumps({'result': answer}))
    return 0


if __name__ == '__main__':
    if len(sys.argv) > 4 and not sys.argv[1].startswith('-'):
        sys.exit(old_command_line())
    sys.exit(main(sys.argv[1:]))
