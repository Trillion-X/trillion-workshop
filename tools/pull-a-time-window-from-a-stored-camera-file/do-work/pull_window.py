GAP = 256 * 1024  # join audio ranges closer than this into one read


def read_range(ident, offset, length, tmp):
    out = f'{tmp}/range.bin'
    env = dict(os.environ, PRODUCT_DATA_ROOT=f'{RUST}/product')
    for _ in range(20):
        run = subprocess.run([READER, STORE, ACCOUNT, 'one', ident, out, str(offset), str(length)],
                             cwd=RUST, env=env, capture_output=True, text=True)
        if run.returncode == 0 and 'ok-range' in run.stdout:
            return pathlib.Path(out).read_bytes()
        time.sleep(3)
    raise SystemExit(f'range read failed at {offset}+{length}: {run.stdout.strip()} {run.stderr.strip()}')


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
        probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-read_intervals', f'{max(t - 10, 0):.2f}%{t + 0.1:.2f}',
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


def main():
    if sys.argv[1] == 'frame':
        return frame(sys.argv[2], float(sys.argv[3]), sys.argv[4])
    ident, start, end, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    with tempfile.TemporaryDirectory() as tmp:
        sparse = sparse_copy(ident, tmp)
        probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-read_intervals',
                                f'{max(start - 1, 0):.2f}%{end + 1:.2f}', '-show_entries', 'packet=pts_time,pos,size',
                                '-of', 'json', sparse], capture_output=True, text=True, check=True)
        packets = [(int(p['pos']), int(p['size'])) for p in json.loads(probe.stdout)['packets'] if p.get('pos')]
        ranges = []
        for pos, size in sorted(packets):
            if ranges and pos - (ranges[-1][0] + ranges[-1][1]) <= GAP:
                ranges[-1][1] = pos + size - ranges[-1][0]
            else:
                ranges.append([pos, size])
        with open(sparse, 'r+b') as f:
            for pos, size in ranges:
                f.seek(pos)
                f.write(read_range(ident, pos, size, tmp))
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-y', '-ss', f'{start:.2f}', '-to', f'{end:.2f}',
                        '-vn', '-i', sparse, '-map', '0:a:0', '-af', f'adelay={round(start * 1000)}:all=1',
                        '-ac', '1', '-ar', '48000', out], check=True)
    fetched = sum(size for _, size in ranges)
    print(f'{ident} {start}-{end}: {len(packets)} audio packets in {len(ranges)} reads, {fetched / 1e6:.1f} MB -> {out}')


main()
