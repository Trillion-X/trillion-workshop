// tools/media-composition: segment-person-matte.py --still, the still-picture mask by a named rembg model. A stand-in
// rembg module (put first on PYTHONPATH) records the model and the arguments each picture is masked with and answers
// a made-up mask, so the test needs no model download: the call is the one the old film script made (one session, only_mask,
// no post-process) and the mask lands beside the picture as <picture>.mask-<model>.png. Needs python3 with Pillow, numpy
// and OpenCV (segment-person-matte.py imports cv2); without them it is skipped with the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../do-work/segment-person-matte.py', import.meta.url));
const probe = spawnSync('python3', ['-c', 'import PIL, numpy, cv2'], { encoding: 'utf8' });
const missing = probe.status !== 0 ? `needs python3 with Pillow, numpy and OpenCV (${(probe.stderr || '').trim().split('\n').at(-1)})` : false;

const STAND_IN = `import json, os
from PIL import Image
LOG = os.environ['STAND_IN_LOG']
def new_session(model):
    open(LOG, 'a').write(json.dumps({'session': model}) + '\\n')
    return {'model': model}
def remove(im, session=None, only_mask=False, post_process_mask=True):
    open(LOG, 'a').write(json.dumps({'mode': im.mode, 'size': list(im.size), 'session': session['model'], 'only_mask': only_mask, 'post_process_mask': post_process_mask}) + '\\n')
    m = Image.new('L', im.size, 0)
    m.paste(255, (im.size[0] // 4, 0, im.size[0] * 3 // 4, im.size[1]))
    return m
`;

test('--still masks each picture with one session of the named model and writes <picture>.mask-<model>.png', { skip: missing }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'still-mask-'));
  try {
    mkdirSync(join(dir, 'stand-in', 'rembg'), { recursive: true });
    writeFileSync(join(dir, 'stand-in', 'rembg', '__init__.py'), STAND_IN);
    const make = spawnSync('python3', ['-c', `from PIL import Image
Image.new('RGBA', (40, 30), (200, 100, 50, 255)).save('${join(dir, 'frame-a.png')}')
Image.new('RGB', (20, 10), (10, 100, 50)).save('${join(dir, 'frame-b.jpg')}')`], { encoding: 'utf8' });
    assert.equal(make.status, 0, make.stderr);
    const env = { ...process.env, PYTHONPATH: join(dir, 'stand-in'), STAND_IN_LOG: join(dir, 'log.jsonl') };
    const run = spawnSync('python3', [script, '--still', 'made-up-model', join(dir, 'frame-a.png'), join(dir, 'frame-b.jpg')], { encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split('\n'), [`ok ${join(dir, 'frame-a.png')}`, `ok ${join(dir, 'frame-b.jpg')}`]);
    const log = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(log, [{ session: 'made-up-model' },
      { mode: 'RGB', size: [40, 30], session: 'made-up-model', only_mask: true, post_process_mask: false },
      { mode: 'RGB', size: [20, 10], session: 'made-up-model', only_mask: true, post_process_mask: false }]);
    assert.ok(existsSync(join(dir, 'frame-a.mask-made-up-model.png')));
    assert.ok(existsSync(join(dir, 'frame-b.mask-made-up-model.png')), 'a picture that is not a .png gets <stem>.mask-<model>.png');
    const check = spawnSync('python3', ['-c', `from PIL import Image
m = Image.open('${join(dir, 'frame-a.mask-made-up-model.png')}'); print(m.mode, m.size, m.getpixel((0, 0)), m.getpixel((20, 15)))
print(Image.open('${join(dir, 'frame-b.jpg')}').mode)`], { encoding: 'utf8' });
    assert.deepEqual(check.stdout.trim().split('\n'), ['L (40, 30) 0 255', 'RGB'], 'the mask is the model\'s own; the picture is untouched');
    const usage = spawnSync('python3', [script, '--still', 'made-up-model'], { encoding: 'utf8', env });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: segment-person-matte.py --still <model> <picture.png>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
