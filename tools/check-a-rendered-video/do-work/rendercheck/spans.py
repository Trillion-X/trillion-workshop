def needed(specs_dir, pad):
    out = []
    for f in sorted(pathlib.Path(specs_dir).glob('*.json')):
        edit = json.load(open(f)).get('edit') or {}
        if not edit.get('preview'):
            continue
        c = Context.__new__(Context)
        c.edit, c.p0 = edit, edit['preview'][0]
        src = [c.source_time(k / FPS) for k in range(int((edit['preview'][1] - edit['preview'][0]) * FPS))]
        k = 0
        while k < len(src):      # one range per stretch of consecutive source frames (a stitched cold open is several stretches)
            j = k
            while j + 1 < len(src) and abs(src[j + 1] - src[j] - 1 / FPS) < 0.5 / FPS:
                j += 1
            if j > k:
                out.append((f.stem, max(src[k] - pad, 0.0), src[j] + 1 / FPS + pad))
            k = j + 1
    return out


def union(ranges):
    merged = []
    for a, b in sorted(ranges):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return merged


def subtract(ranges, covered):
    for ca, cb in covered:
        nxt = []
        for a, b in ranges:
            if cb <= a or ca >= b:
                nxt.append([a, b])
                continue
            if a < ca:
                nxt.append([a, ca])
            if cb < b:
                nxt.append([cb, b])
        ranges = nxt
    return ranges


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', str(path)],
                       capture_output=True, text=True, check=True)
    j = json.loads(r.stdout)
    return j['streams'][0]['width'], j['streams'][0]['height'], j['streams'][0]['r_frame_rate'], float(j['format']['duration'])


def main():
    specs_dir, pad = sys.argv[1], float(sys.argv[sys.argv.index('--pad') + 1]) if '--pad' in sys.argv else 1.0
    covered = [[s['from'], s['to']] for s in json.load(open(CONFIG))['placement']['bases']['/options-ch1/']]
    per_option = needed(specs_dir, pad)
    todo = [[round(a, 2), round(b, 2)] for a, b in subtract(union([(a, b) for _, a, b in per_option]), covered)]
    for name, a, b in per_option:
        print(f'{name}: his cut {a:.1f}-{b:.1f}s')
    print(f'already held: {covered}\nto export: {todo}, {sum(b - a for a, b in todo):.1f} s')
    if '--dry-run' in sys.argv or not todo:
        return 0
    items = json.load(open(PROJECT))['project']['items']
    gone = [p for p in (v['kind']['Media']['media']['File']['path'] for v in items.values() if 'Media' in v['kind'] and 'File' in v['kind']['Media'].get('media', {})) if not os.path.isfile(p)]
    if gone:
        print('source media offline, nothing exported:\n  ' + '\n  '.join(gone))
        return 2
    import rounds
    done = []
    for a, b in todo:
        out = OPT / 'work' / f'ch1-base-{a:g}-{b:g}.mp4'
        rounds.filmcraft_export(str(PROJECT), str(out), a, b, scale=0.5, quality=70)
        w, h, rate, dur = probe(out)
        assert (w, h) == (1920, 1080) and rate == '24000/1001' and abs(dur - (b - a)) <= 0.2, f'{out.name} is {w}x{h} {rate} {dur:.2f}s, wanted 1920x1080 24000/1001 {b - a:.2f}s'
        done.append({'file': f'work/{out.name}', 'from': a, 'to': b})
        print(f'wrote {out.name}, {dur:.2f} s')
    last = covered[-1]
    add = ''.join(f',\n        {{\n          "file": "{d["file"]}",\n          "from": {d["from"]},\n          "to": {d["to"]}\n        }}' for d in done)
    edit = [{'file': 'library/tool-settings/check-a-rendered-video-limits.json', 'old': f'"to": {float(last[1])}\n        }}\n      ]', 'new': f'"to": {float(last[1])}\n        }}{add}\n      ]'}]
    (ROOT / 'tools' / 'checker-owner' / 'edits' / 'r8f-spans-config.json').write_text(json.dumps(edit, indent=1), encoding='utf-8')
    print('wrote tools/checker-owner/edits/r8f-spans-config.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
