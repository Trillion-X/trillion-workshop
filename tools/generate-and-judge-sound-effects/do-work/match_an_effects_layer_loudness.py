# Scale every sound in a variant palette by one common gain so the variant's SFX layer (place_cues_into_an_effects_layer.py over the cue plan)
# has the same integrated loudness as A's. Per-sound balance and every cue gain stay as they are, so a listener compares
# the sounds, not "louder effects". Writes <palette>/level.json. usage: python3 -I match_an_effects_layer_loudness.py PALETTE CUES REF_LAYER.wav
# (the last line printed is {"result": {layer_lufs_before, target_lufs, common_gain_db}}).
import json, pathlib, sys, tempfile
import soundfile as sf

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))   # -I leaves the script's folder off the path
from place_cues_into_an_effects_layer import SR, layer, lufs   # noqa: E402

pal, cues, ref = pathlib.Path(sys.argv[1]), json.loads(pathlib.Path(sys.argv[2]).read_text()), sys.argv[3]
with tempfile.TemporaryDirectory() as d:
    f = pathlib.Path(d) / 'layer.wav'
    sf.write(f, layer(pal, cues), SR, subtype='FLOAT')
    before = lufs(f)
target = lufs(ref)
g = round(target - before, 2)
for w in sorted(pal.glob('*.wav')):
    x, sr = sf.read(w, always_2d=True)
    sf.write(w, x * 10 ** (g / 20), sr, subtype='PCM_24')
(pal / 'level.json').write_text(json.dumps({'layer_lufs_before': before, 'target_lufs': target, 'common_gain_db': g}, indent=1))
print(pal, 'layer', before, '->', target, 'LUFS, common gain', g, 'dB')
print(json.dumps({'result': {'layer_lufs_before': before, 'target_lufs': target, 'common_gain_db': g}}))
