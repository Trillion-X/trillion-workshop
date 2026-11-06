// The local sound makers of make-pictures-and-sounds: each style is a row whose maker runs a program once for every
// result (makes_all), the person's settings for this computer are laid over the row's, a list input becomes one
// argument per item, the recording is handed on when no frames are cut, and the Python maker programs run against
// stand-in model modules (test/test_local_sound_makers.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStyle, readMakeRows } from '../do-work/make-pictures-and-sounds.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = readMakeRows();
const LOCAL = ['sound-effect-forged-on-my-computer', 'sound-effect-from-stable-audio-3-on-my-computer', 'sound-effect-from-moss-on-my-computer', 'sound-effects-for-a-video-from-hunyuan-foley-on-my-computer'];

// A stand-in program run: records what it was given and writes `made` files (name -> bytes) into the folder it is handed.
function standIn(seen, made) {
  return async (program, args) => {
    seen.push([program, ...args]);
    const dir = args[args.indexOf('--dir') + 1];
    for (const [name, bytes] of Object.entries(made)) writeFileSync(join(dir, name), bytes);
    return { code: 0, stderr: '' };
  };
}

test('every local sound style runs on the person\'s computer through a maker that makes all its results in one run', () => {
  for (const id of LOCAL) {
    const style = rows.styles.get(id);
    const maker = rows.makers.get(style.maker);
    assert.deepEqual(style.placements, ['placement:your-computer'], id);
    assert.equal(maker.runs_as, 'process');
    assert.equal(maker.makes_all, true);
    assert.equal(maker.key, undefined, 'no account and no key');
    const program = maker.command.find(part => typeof part === 'string' && part.startsWith('do-work/'));
    if (program) assert.ok(existsSync(join(folder, program)), program);
    assert.equal(style.media_type, 'audio/wav');
  }
});

test('the forge maker gets each confusion and each reference as its own argument, and the person\'s settings over the row\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-'));
  try {
    const seen = [];
    const result = await makeStyle({
      rows, styleId: 'sound-effect-forged-on-my-computer', outDir: join(dir, 'made'), workDir: join(dir, 'work'),
      input: { sound: 'a tiny short crisp tick click', recipe: 'click', alts: ['a wooden knock', 'a finger snap'], refs: ['/sounds/tick.wav'], count: 2 },
      personSettings: { earshot: '/opt/earshot/bin/earshot', robust: 4, tone: 1.5 },
      deps: { runProcess: standIn(seen, { 'click_01.wav': 'RIFF one', 'click_02.wav': 'RIFF two', 'report.json': '{}' }) },
    });
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.made.map(item => item.file.split('/').pop()), ['sound-effect-forged-on-my-computer-1.wav', 'sound-effect-forged-on-my-computer-2.wav']);
    assert.equal(readFileSync(result.made[1].file, 'utf8'), 'RIFF two');
    const [program, ...args] = seen[0];
    assert.equal(program, '/opt/earshot/bin/earshot');
    assert.deepEqual(args.slice(0, 2), ['forge', 'click']);
    const after = flag => args.slice(args.indexOf(flag) + 1, args.findIndex((arg, at) => at > args.indexOf(flag) && arg.startsWith('--')));
    assert.deepEqual(after('--target'), ['a tiny short crisp tick click']);
    assert.deepEqual(after('--alts'), ['a wooden knock', 'a finger snap']);
    assert.deepEqual(after('--refs'), ['/sounds/tick.wav']);
    assert.deepEqual([after('--keep'), after('--robust'), after('--tone'), after('--budget')], [['2'], ['4'], ['1.5'], ['160']]);
    assert.equal(seen.length, 1, 'one run for every result');
    assert.deepEqual(readdirSync(join(dir, 'work')), [], 'the run\'s folder is cleared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a model maker keeps what each result says about itself, and says when it made fewer than asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa3-'));
  try {
    const seen = [];
    const result = await makeStyle({
      rows, styleId: 'sound-effect-from-stable-audio-3-on-my-computer', outDir: join(dir, 'made'), workDir: join(dir, 'work'),
      input: { sound: 'one laptop key press', seconds: 1, count: 3 }, personSettings: { python: '/venv/bin/python', weights: '/models/sa3', seed: 5 },
      deps: { runProcess: standIn(seen, { 's000005.wav': 'RIFF', 's000005.wav.json': JSON.stringify({ seed: 5 }), 's000006.wav': 'RIFF' }) },
    });
    assert.equal(result.made.length, 2);
    assert.deepEqual(result.made[0].about, { seed: 5 });
    assert.equal(result.made[1].about, undefined);
    assert.match(result.failed[0].error, /made 2 of the 3 asked for/);
    assert.deepEqual(seen[0].slice(0, 2), ['/venv/bin/python', 'do-work/make-sound-with-stable-audio-3.py']);
    assert.deepEqual(seen[0].slice(seen[0].indexOf('--seed'), seen[0].indexOf('--seed') + 4), ['--seed', '5', '--count', '3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a setting the person has not given stops the run by name, before anything runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moss-'));
  try {
    const seen = [];
    const result = await makeStyle({
      rows, styleId: 'sound-effect-from-moss-on-my-computer', outDir: join(dir, 'made'), workDir: join(dir, 'work'),
      input: { sound: 'a tick', seconds: 1 }, deps: { runProcess: standIn(seen, {}) },
    });
    assert.equal(result.made.length, 0);
    assert.match(result.failed[0].error, /needs settings\.weights.*--settings/);
    assert.equal(seen.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the video maker is handed the video itself and one --at per section start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foley-'));
  try {
    const seen = [];
    await assert.rejects(makeStyle({ rows, styleId: 'sound-effects-for-a-video-from-hunyuan-foley-on-my-computer', outDir: join(dir, 'm'), workDir: join(dir, 'w'), input: { sounds: 'soft clicks' } }), /Choose the video/);
    const result = await makeStyle({
      rows, styleId: 'sound-effects-for-a-video-from-hunyuan-foley-on-my-computer', outDir: join(dir, 'made'), workDir: join(dir, 'work'),
      input: { video: '/films/cut.mp4', sounds: 'soft UI foley, no music', section_starts: [7.5, 29.15] },
      personSettings: { code: '/src/foley', weights: '/models/foley' },
      deps: { runProcess: standIn(seen, { 's000001.wav': 'RIFF' }) },
    });
    assert.equal(result.made.length, 1);
    const args = seen[0];
    assert.equal(args[args.indexOf('--video') + 1], '/films/cut.mp4');
    assert.deepEqual(args.slice(args.indexOf('--at') + 1, args.indexOf('--most-seconds')), ['7.5', '29.15']);
    assert.equal(args[args.indexOf('--negative') + 1], 'music, speech, singing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command line takes the person\'s settings file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  try {
    writeFileSync(join(dir, 'settings.json'), '[1]');
    const run = spawnSync(process.execPath, [join(folder, 'do-work/make-pictures-and-sounds.mjs'), '--style', 'sound-effect-from-moss-on-my-computer', '--settings', join(dir, 'settings.json')], { input: '{"sound":"a tick","seconds":1}', encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--settings must name a file holding one JSON object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
test('the maker programs run against stand-in models', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', join(folder, 'test/test_local_sound_makers.py')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
