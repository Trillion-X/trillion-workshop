        gate = min(230.0, (ratio or GATE_RATIO) * base)
    cand = keep & (f0 >= gate) & (np.abs(d['emb']).sum(1) > 0)
    conf = cand & (p > 0.7)
    if conf.sum() < 5:
        conf = np.zeros(len(t), bool); conf[np.argsort(-(p * cand))[:10]] = True
    c = E[conf].mean(0); c /= (np.linalg.norm(c) + 1e-9)
    cos = E @ c
    hf = cand & (cos > tau)
    turns, cur = [], None
    for i in range(len(t)):
        c0, c1 = t[i] + 0.5, t[i] + 1.0           # the middle 0.5 s of the window
        if hf[i]:
            if cur and c0 - cur[1] <= 1.0: cur[1] = c1
            else:
                if cur: turns.append(cur)
                cur = [c0, c1]
    if cur: turns.append(cur)
    turns = [[round(float(a), 2), round(float(b), 2)] for a, b in turns if b - a >= 0.75]
    res = {'id': os.path.basename(npz).split('.')[0], 'duration_s': round(float(t[-1] + WIN), 1),
           'character_s': round(sum(b - a for a, b in turns), 1), 'turns': turns, 'tau': tau, 'gate_hz': round(gate, 1), 'episode_median_f0': round(base, 1),
           'confident_windows': int(conf.sum()), 'voice_cos_of_confident': round(float(cos[conf].mean()), 3),
           'p': [round(float(x), 3) for x in p], 'cos': [round(float(x), 3) for x in cos]}
    if out: json.dump(res, open(out, 'w'))
    return res

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'embed': embed(sys.argv[2], sys.argv[3])
    elif cmd == 'seed': seed(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == 'batch':                         # batch <catalog.tsv> <audio_dir>: episodes first, Basement last
        import csv
        rows = list(csv.DictReader(open(sys.argv[2]), delimiter='\t'))
        order = {'episode': 0, 'compilation': 1, 'side': 2, 'basement': 3}
        todo = sorted(rows, key=lambda r: order.get(r['format'], 9))
        if len(sys.argv) > 4 and sys.argv[4] == 'reverse':   # a second process can work from the other end
            todo = [r for r in todo if r['format'] == 'episode'][::-1]
        for r in todo:
            if r['format'] not in order: continue
            a = os.path.join(sys.argv[3], r['id'] + '.m4a'); e = os.path.join(VOICE, r['id'] + '.emb.npz')
            h = os.path.join(VOICE, r['id'] + '.turns.json')
            if not os.path.exists(a) or os.path.exists(h) or os.path.exists(e + '.lock'): continue
            open(e + '.lock', 'w').close()
            try:
                if not os.path.exists(e): embed(a, e)
                x = score(e, h); print(x['id'], x['duration_s'], 'character_s', x['character_s'], 'turns', len(x['turns']), flush=True)
            except Exception as ex:
                print('fail', r['id'], ex, flush=True)
            finally:
                if os.path.exists(e + '.lock'): os.remove(e + '.lock')
    elif cmd == 'rescore':                       # rescore every .emb.npz with the current seeds (one model fit)
        import glob
        for e in sorted(glob.glob(os.path.join(VOICE, '*.emb.npz'))):
            x = score(e, e.replace('.emb.npz', '.turns.json'))
            print(x['id'], x['character_s'], len(x['turns']), flush=True)
    elif cmd == 'score':
        r = score(sys.argv[2], sys.argv[4] if len(sys.argv) > 4 and sys.argv[3] == '--json' else None)
        print(r['id'], r['duration_s'], 'character_s', r['character_s'], 'turns', len(r['turns']))
