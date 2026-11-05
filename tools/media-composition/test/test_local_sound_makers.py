"""The three local sound maker programs (do-work/make-sound-*.py) run against stand-in model modules written here:
a torch with no GPU, and a Stable Audio 3, a MOSS-SoundEffect and a HunyuanVideo-Foley that answer a tone. What is
tested is the programs' own work: one load for every seed, the seeds, the scaling under full scale, the sidecars, the
window cut and the seams. Needs numpy, soundfile and ffmpeg; skips and says why without them.
"""
import json
import pathlib
import runpy
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

HERE = pathlib.Path(__file__).resolve().parent
DO_WORK = HERE.parent / 'do-work'
try:
    import numpy as np
    import soundfile as sf
    HAVE, WHY = shutil.which('ffmpeg') is not None, 'needs ffmpeg'
except ImportError as e:  # pragma: no cover
    HAVE, WHY = False, f'needs numpy and soundfile ({e})'

LOADS = []


class Tensor:
    """just enough of a torch tensor: float(), cpu(), numpy(), to(), indexing"""
    def __init__(self, a):
        self.a = np.asarray(a)

    def __getitem__(self, i):
        return Tensor(self.a[i])

    def float(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.a

    def to(self, *_):
        return self


def stand_in_torch():
    torch = types.ModuleType('torch')
    torch.backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
    torch.bfloat16 = 'bfloat16'
    torch.device = lambda name: name
    torch.manual_seed = lambda seed: None

    class Inference:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False
    torch.inference_mode = Inference
    return torch


def stand_in_sa3(rate=1000):
    """generate() answers latents that decode to a tone of amplitude 1 + seed / 2 (so it reaches over full scale)"""
    mod, model_mod = types.ModuleType('stable_audio_3'), types.ModuleType('stable_audio_3.model')

    class Pretransform:
        def parameters(self):
            return iter([types.SimpleNamespace(dtype='float32')])

        def decode(self, lat):
            t = np.arange(int(lat.seconds * rate)) / rate
            return Tensor([np.stack([lat.amp * np.sin(2 * np.pi * 50 * t)] * 2)])

    class StableAudioModel:
        def __init__(self, inner, cfg, device, half):
            LOADS.append(('sa3', device))
            self.model = types.SimpleNamespace(pretransform=Pretransform())

        def generate(self, prompt, duration, seed, return_latents):
            return types.SimpleNamespace(seconds=duration, amp=1 + seed / 2, to=lambda dtype: types.SimpleNamespace(seconds=duration, amp=1 + seed / 2))
    model_mod.StableAudioModel = StableAudioModel
    model_mod.load_diffusion_cond = lambda cfg, path, device, model_half: 'inner'
    return {'stable_audio_3': mod, 'stable_audio_3.model': model_mod}


def stand_in_moss():
    mod = types.ModuleType('moss_soundeffect_v2')

    class Pipe:
        sample_rate = 1000

        @classmethod
        def from_pretrained(cls, path, torch_dtype, device):
            LOADS.append(('moss', path))
            return cls()

        def __call__(self, prompt, seconds, num_inference_steps, seed):
            return [Tensor(np.full((2, int(seconds * 1000)), seed / 10.0)) for _ in prompt]
    mod.MossSoundEffectPipeline = Pipe
    return {'moss_soundeffect_v2': mod}


def stand_in_foley():
    utils = types.ModuleType('hunyuanvideo_foley.utils')
    model_utils, feature_utils = types.ModuleType('hunyuanvideo_foley.utils.model_utils'), types.ModuleType('hunyuanvideo_foley.utils.feature_utils')

    def load_model(weights, config, device):
        LOADS.append(('foley', weights))
        return {}, {}

    def feature_process(video, prompt, model_dict, cfg, neg_prompt):
        seconds = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video],
                                       capture_output=True, text=True, check=True).stdout)
        return 'vf', 'tf', seconds

    def denoise_process(vf, tf, secs, model_dict, cfg, guidance_scale, num_inference_steps):
        return Tensor([np.ones((2, int(secs * 1000) + 30))]), 1000   # a little longer than asked: the program cuts it
    model_utils.load_model, model_utils.denoise_process, feature_utils.feature_process = load_model, denoise_process, feature_process
    return {'hunyuanvideo_foley': types.ModuleType('hunyuanvideo_foley'), 'hunyuanvideo_foley.utils': utils,
            'hunyuanvideo_foley.utils.model_utils': model_utils, 'hunyuanvideo_foley.utils.feature_utils': feature_utils}


def run_program(name, argv, modules):
    saved, argv0 = {k: sys.modules.get(k) for k in modules}, sys.argv
    sys.modules.update(modules)
    try:
        sys.argv = [name, *argv]
        runpy.run_path(str(DO_WORK / name), run_name='__main__')
    finally:
        sys.argv = argv0
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


@unittest.skipUnless(HAVE, WHY)
class Makers(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        LOADS.clear()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_stable_audio_loads_once_and_scales_loud_seeds_under_full_scale(self):
        weights = self.dir / 'weights'
        weights.mkdir()
        (weights / 'model_config.json').write_text(json.dumps({'sample_rate': 1000, 'model': {'conditioning': {'configs': [
            {'type': 't5gemma', 'config': {'repo_id': 'somewhere'}}]}}}))
        out = self.dir / 'out'
        run_program('make-sound-with-stable-audio-3.py', ['--weights', str(weights), '--prompt', 'a tick', '--seconds', '0.5',
                                                          '--seed', '1', '--count', '2', '--dir', str(out)],
                    {'torch': stand_in_torch(), **stand_in_sa3()})
        self.assertEqual(LOADS, [('sa3', 'cpu')])
        self.assertEqual(sorted(p.name for p in out.glob('*.wav')), ['s000001.wav', 's000002.wav'])
        x, rate = sf.read(out / 's000002.wav')
        self.assertEqual((rate, len(x)), (1000, 500))
        self.assertAlmostEqual(np.abs(x).max(), 10 ** (-0.1 / 20), places=4)
        about = json.loads((out / 's000002.wav.json').read_text())
        self.assertEqual((about['seed'], about['prompt'], about['decoded_peak']), (2, 'a tick', 2.0))

    def test_stable_audio_refuses_a_folder_without_its_weights(self):
        with self.assertRaisesRegex(SystemExit, 'model_config.json'):
            run_program('make-sound-with-stable-audio-3.py', ['--weights', str(self.dir), '--prompt', 'x', '--seconds', '1',
                                                              '--seed', '1', '--count', '1', '--dir', str(self.dir / 'o')],
                        {'torch': stand_in_torch(), **stand_in_sa3()})

    def test_moss_makes_one_file_per_seed(self):
        out = self.dir / 'out'
        run_program('make-sound-with-moss-soundeffect.py', ['--weights', str(self.dir), '--prompt', 'a tick', '--seconds', '0.2',
                                                            '--steps', '50', '--seed', '3', '--count', '2', '--dir', str(out)],
                    {'torch': stand_in_torch(), **stand_in_moss()})
        self.assertEqual(LOADS, [('moss', str(self.dir))])
        x, _ = sf.read(out / 's000004.wav')
        self.assertAlmostEqual(float(x.max()), 0.4, places=5)
        self.assertEqual(json.loads((out / 's000003.wav.json').read_text())['steps'], 50)

    def test_foley_windows_follow_the_sections_and_the_stem_keeps_the_video_length(self):
        video = self.dir / 'cut.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=64x48:rate=25', '-pix_fmt', 'yuv420p', str(video)], check=True)
        code = self.dir / 'code'
        (code / 'configs').mkdir(parents=True)
        (code / 'configs' / 'hunyuanvideo-foley-xxl.yaml').write_text('')
        out = self.dir / 'out'
        run_program('make-sound-for-a-video-with-hunyuan-foley.py', ['--code', str(code), '--weights', str(self.dir), '--video', str(video),
                                                                     '--prompt', 'soft clicks', '--seed', '1', '--count', '1',
                                                                     '--dir', str(out), '--at', '2', '--most-seconds', '3'],
                    {'torch': stand_in_torch(), **stand_in_foley()})
        x, rate = sf.read(out / 's000001.wav', always_2d=True)
        self.assertEqual(len(x), 4000, 'each window cut to its own length, so the seams stay on time')
        self.assertEqual([float(x[i, 0]) for i in (1000, 1999, 2000, 3000)], [1.0, 0.0, 0.0, 1.0], '5 ms fades meet at the seam')
        about = json.loads((out / 's000001.wav.json').read_text())
        self.assertEqual([w['window'] for w in about['windows']], [[0.0, 2.0], [2.0, 4.0]])
        self.assertEqual(LOADS, [('foley', str(self.dir))])
        self.assertEqual(sorted(p.name for p in (out / 'windows').glob('*.wav')), ['s000001-win0.wav', 's000001-win1.wav'])

    def test_foley_sections_merge_up_to_the_limit_and_a_long_one_splits_in_equal_parts(self):
        video = self.dir / 'long.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=40:size=32x24:rate=5', '-pix_fmt', 'yuv420p', str(video)], check=True)
        code = self.dir / 'code'
        (code / 'configs').mkdir(parents=True)
        (code / 'configs' / 'hunyuanvideo-foley-xxl.yaml').write_text('')
        out = self.dir / 'out'
        run_program('make-sound-for-a-video-with-hunyuan-foley.py', ['--code', str(code), '--weights', str(self.dir), '--video', str(video),
                                                                     '--prompt', 'soft clicks', '--seed', '1', '--count', '1', '--dir', str(out),
                                                                     '--at', '7.5', '29.15', '38.5', '--lock', str(self.dir / 'render.lock')],
                    {'torch': stand_in_torch(), **stand_in_foley()})
        about = json.loads((out / 's000001.wav.json').read_text())
        self.assertEqual([w['window'] for w in about['windows']], [[0.0, 7.5], [7.5, 18.325], [18.325, 29.15], [29.15, 40.0]])
        self.assertFalse((self.dir / 'render.lock').exists(), 'the lock is given back after the cuts')


if __name__ == '__main__':
    unittest.main()
