"""Find the stretches of a recording spoken in a high pitch band, by pitch alone: a first look at a character voiced well
above the rest of the cast, before any windows are labelled (pitch alone also catches every other high voice;
do-work/find_voice.py tells them apart).
Writes <out_dir>/<id>.json: per-frame-free summary = runs of high-pitch voiced speech (start, end, median F0), and
<out_dir>/<id>.f0.npy, the pitch of each voiced frame (0 elsewhere).
One JSON request on standard input: {audio, out_dir, settings_record?, settings?}; the settings give the character's band
(pitch_run_band_low_hz, pitch_run_band_high_hz). {"result": ...} is the last line printed."""
import sys, os, json, subprocess, numpy as np, librosa
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'read-data'))
import shared  # noqa: E402
SR, HOP, FRAME = 8000, 200, 800          # 25 ms hop
LO, HI = 225.0, 600.0                     # the character's band, set from the settings
MIN_RUN, MERGE_GAP = 0.5, 1.2             # seconds

def f0_track(path):
    """librosa.yin pitch plus a periodicity score (normalised autocorrelation at the yin period) as the voicing test;
    about 50x faster than pyin, which took over 10 min for one 54-min episode on the busy Mac."""
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                         capture_output=True, check=True).stdout
    y = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    f0 = librosa.yin(y, fmin=80, fmax=HI, sr=SR, frame_length=FRAME, hop_length=HOP, center=False)
    fr = librosa.util.frame(y, frame_length=FRAME, hop_length=HOP)  # (FRAME, n), a view
    n = min(len(f0), fr.shape[1])
    f0 = f0[:n]
    lag = np.clip(np.round(SR / f0).astype(int), 1, FRAME // 2 - 1)
    per = np.zeros(n, np.float32); rms = np.zeros(n, np.float32)
    W = FRAME // 2
    for i in range(0, n, 4096):
        blk = fr[:, i:i + 4096].T                                  # (b, FRAME)
        a = blk[:, :W]
        L = lag[i:i + 4096]
        idx = np.arange(W)[None, :] + L[:, None]
        b = np.take_along_axis(blk, idx, axis=1)
        num = (a * b).sum(1); den = np.sqrt((a * a).sum(1) * (b * b).sum(1)) + 1e-9
        per[i:i + 4096] = num / den
        rms[i:i + 4096] = np.sqrt((a * a).mean(1))
    loud = rms > max(0.01, np.percentile(rms, 30))
    vf = (per > 0.6) & loud
    return f0, vf, per

def runs(f0, vf, vp):
    hi = vf & (f0 >= LO)
    t = np.arange(len(f0)) * HOP / SR
    segs, start = [], None
    for i, h in enumerate(hi):
        if h and start is None: start = i
        if (not h) and start is not None:
            segs.append([start, i]); start = None
    if start is not None: segs.append([start, len(hi)])
    merged = []
    for s, e in segs:                          # merge across short gaps (unvoiced consonants, pauses)
        if merged and (s - merged[-1][1]) * HOP / SR <= MERGE_GAP:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    out = []
    for s, e in merged:
        dur = (e - s) * HOP / SR
        voiced = f0[s:e][vf[s:e]]
        hi_share = float(np.mean(voiced >= LO)) if len(voiced) else 0
        if dur >= MIN_RUN and hi_share >= 0.5:
            out.append({'start': round(t[s], 2), 'end': round(t[s] + dur, 2), 'f0_median': round(float(np.median(voiced)), 1),
                        'hi_share': round(hi_share, 2)})
    return out

if __name__ == '__main__':
    req, s = shared.request(['pitch_run_band_low_hz', 'pitch_run_band_high_hz'])
    LO, HI = float(s['pitch_run_band_low_hz']), float(s['pitch_run_band_high_hz'])
    path, od = shared.needed(req, 'audio', 'out_dir')
    os.makedirs(od, exist_ok=True)
    f0, vf, vp = f0_track(path)
    total = len(f0) * HOP / SR
    voiced = f0[vf]
    r = runs(f0, vf, vp)
    vid = os.path.basename(path).rsplit('.', 1)[0]
    res = {'id': vid, 'duration_s': round(total, 1), 'voiced_s': round(len(voiced) * HOP / SR, 1),
           'voiced_f0_median': round(float(np.median(voiced)), 1) if len(voiced) else None,
           'hi_runs': r, 'hi_s': round(sum(x['end'] - x['start'] for x in r), 1),
           'method': f'librosa.yin {SR} Hz hop {HOP}; periodicity > 0.6 and loudness above the 30th percentile; band {LO}-{HI} Hz, runs >= {MIN_RUN} s merged over {MERGE_GAP} s'}
    np.save(os.path.join(od, vid + '.f0.npy'), np.where(vf, f0, 0).astype(np.float32))
    json.dump(res, open(os.path.join(od, vid + '.json'), 'w'), indent=1)
    print(vid, res['duration_s'], 'hi_s', res['hi_s'], 'runs', len(r))
    shared.answer({'id': vid, 'json': os.path.join(od, vid + '.json'), 'hi_s': res['hi_s'], 'runs': len(r)})
