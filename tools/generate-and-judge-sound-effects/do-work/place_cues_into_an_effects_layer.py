# The SFX layer alone: every cue of a cue plan placed at its frame with its gain, as audio/mix.py places it (sample
# delay, gain in dB, summed), with no music and no voice. Used to measure and to listen to the effects without the mix
# around them. usage: python3 -I place_cues_into_an_effects_layer.py PALETTE_DIR CUES.json OUT.wav
# (CUES.json: {DUR, cues: [[seconds, sound, gain_db], ...]}; the last line printed is {"result": {"layer", "lufs"}}).
import json, pathlib, subprocess, sys
import numpy as np
import soundfile as sf

SR = 48000


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def layer(palette, plan):
    palette = pathlib.Path(palette)
    n = int(round(plan['DUR'] * SR))
    y = np.zeros((n, 2))
    cache = {}
    for t, name, g in plan['cues']:
        x = cache.setdefault(name, load(palette / f'{name}.wav'))
        a = int(max(0, t) * 1000) * SR // 1000          # mix.py delays by whole milliseconds
        b = min(n, a + len(x))
        y[a:b] += x[:b - a] * 10 ** (g / 20)
    return y


def lufs(path):
    r = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', str(path), '-af', 'ebur128', '-f', 'null', '-'],
                       capture_output=True, text=True).stderr
    return float(r.rsplit('I:', 1)[1].split('LUFS')[0])


if __name__ == '__main__':
    pal, cues, out = sys.argv[1:4]
    sf.write(out, layer(pal, json.loads(pathlib.Path(cues).read_text())), SR, subtype='FLOAT')
    level = lufs(out)
    print(out, 'integrated', level, 'LUFS')
    print(json.dumps({'result': {'layer': out, 'lufs': level}}))
