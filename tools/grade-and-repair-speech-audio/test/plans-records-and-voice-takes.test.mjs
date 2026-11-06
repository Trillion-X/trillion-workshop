// The parts moved in from a film edit's audio grade and its narrator voice checks, run for real on made-up data:
// - spans_from_plans.py turns edit plans into the spans file (cuts only, sources from the plan or the clip's word file,
//   word times from a whisper result first), and the grade then writes one grades file per plan (groups/<plan>.json);
// - --settings-record reads the person's record:setting rows (a person's row, then a film's laid over it) through
//   tools/settings, gives the same grades as the same values in a settings file, and refuses another tool's row or a
//   retired one;
// - the voice-take checks on a synthetic take with a click in one word, a tick in a pause and word starts read early:
//   check_voice_take.py flags the click's word, clean_voice_take_pauses.py silences the pauses, tighten_word_starts.py
//   moves the starts to the voice and keeps the script's spelling, and the two earshot scripts run on a stand-in earshot.
// Needs python3 with numpy, scipy and soundfile, and ffmpeg (librosa too for the two pitch checks); without them the
// tests skip and say why.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const doWork = join(folder, 'do-work');
const python = (argv, env = {}) => spawnSync('python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
const last = (run) => JSON.parse(run.stdout.trim().split('\n').pop());
const environment = JSON.parse(python([join(here, 'check_environment.py')]).stdout.trim().split('\n').pop());
const skip = environment.ok ? false : `needs python3 with numpy, scipy and soundfile, and ffmpeg (${environment.reason})`;
const librosa = python(['-c', 'import librosa']).status === 0;
const skipPitch = skip || (!librosa && 'needs librosa');
const settings = JSON.parse(readFileSync(join(here, 'settings-for-synthetic-speech.json'), 'utf8'));
const earshot = { PYTHONPATH: join(here, 'stand-in-earshot') };

let work, spans;
before(() => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), 'plans-records-takes-'));
  assert.equal(python([join(here, 'build_fixture.py'), join(work, 'media')]).status, 0, 'the fixture builds');
  spans = JSON.parse(readFileSync(join(work, 'media', 'spans.json'), 'utf8')).spans;
  for (const name of ['plans', 'transcripts', 'wordtimes']) mkdirSync(join(work, name));
  const cut = (s) => ({ kind: 'answer', clip: s.clip, from: s.from, to: s.to, text: s.text });
  // clean: its source is in the plan, its words in a whisper result; noisy: both from its word file; clipped: no words
  writeFileSync(join(work, 'wordtimes', 'clean.json'), JSON.stringify({ segments: [{ words: spans[0].words.map((w) => ({ word: ` ${w.text}`, start: w.start, end: w.end })) }] }));
  writeFileSync(join(work, 'transcripts', 'noisy.words.json'), JSON.stringify({ source: spans[1].source, words: spans[1].words }));
  writeFileSync(join(work, 'transcripts', 'clipped.words.json'), JSON.stringify({ source: spans[2].source, words: [] }));
  writeFileSync(join(work, 'plans', 'one.json'), JSON.stringify({ sources: { clean: spans[0].source }, segments: [{ kind: 'asker', clip: null, text: 'a generated line' }, cut(spans[0]), cut(spans[1])] }));
  writeFileSync(join(work, 'plans', 'two.json'), JSON.stringify({ sources: { clean: spans[0].source }, segments: [cut(spans[0]), cut(spans[2])] }));
});

test('edit plans become the spans file: cuts only, with their sources and the words inside each cut', { skip }, () => {
  const made = python([join(doWork, 'spans_from_plans.py'), '--plans', join(work, 'plans'), '--transcripts', join(work, 'transcripts'),
    '--wordtimes', join(work, 'wordtimes'), '--out', join(work, 'spans.json')]);
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(last(made).result, { spans: join(work, 'spans.json'), count: 4, plans: 2 });
  const file = JSON.parse(readFileSync(join(work, 'spans.json'), 'utf8'));
  assert.deepEqual(file.groups, { one: ['clean_0.40_5.00', 'noisy_0.40_5.00'], two: ['clean_0.40_5.00', 'clipped_0.40_5.00'] });
  assert.deepEqual(file.spans.map((s) => [s.clip, s.source]), [['clean', spans[0].source], ['noisy', spans[1].source], ['clean', spans[0].source], ['clipped', spans[2].source]]);
  assert.deepEqual(file.spans[0].words, spans[0].words, 'the whisper result\'s words, trimmed of their leading space');
  assert.deepEqual(file.spans[1].words, spans[1].words, 'the word file\'s words');
  assert.equal(file.spans[3].words, undefined, 'a clip with no word times has none');
});

test('the grade writes one grades file per plan beside grades.json, a shared cut graded once', { skip }, () => {
  writeFileSync(join(work, 'settings.json'), JSON.stringify(settings));
  const ran = python([join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--settings', join(work, 'settings.json'), '--out', join(work, 'out')]);
  assert.equal(ran.status, 0, ran.stderr);
  const all = JSON.parse(readFileSync(join(work, 'out', 'grades.json'), 'utf8'));
  assert.deepEqual(Object.keys(all.spans), ['clean_0.40_5.00', 'noisy_0.40_5.00', 'clipped_0.40_5.00']);
  const one = JSON.parse(readFileSync(join(work, 'out', 'groups', 'one.json'), 'utf8'));
  const two = JSON.parse(readFileSync(join(work, 'out', 'groups', 'two.json'), 'utf8'));
  assert.deepEqual(one.counts, { good: 1, remaster: 1, clone: 0 });
  assert.deepEqual(two.counts, { good: 1, remaster: 1, clone: 0 });
  assert.deepEqual(one.spans['clean_0.40_5.00'], all.spans['clean_0.40_5.00']);
  assert.equal(one.spans['clean_0.40_5.00'].audio, 'audio/clean_0.40_5.00.wav', 'audio paths are relative to the output folder');
  assert.equal(two.settings.snr_db_min, settings.snr_db_min);
});

const row = (scopeKind, scopeId, values, extra = {}) => ({
  id: `record:setting:grade-and-repair-speech-audio~${scopeKind}~${scopeId}`, type: 'record:setting',
  value: { name: 'made-up settings', tool: 'tool:grade-and-repair-speech-audio', scope_kind: scopeKind, scope_id: scopeId,
    settings: JSON.stringify(values), from: 'made up for the tests', status: 'active', ...extra },
});

test('--settings-record reads the person\'s rows, a film\'s laid over the person\'s, and grades the same as the file', { skip }, () => {
  const { handle_seconds, speaker_similarity_min, ...person } = settings;
  writeFileSync(join(work, 'person.json'), JSON.stringify(row('person', 'someone', { ...person, handle_seconds: 9 })));
  writeFileSync(join(work, 'film.json'), JSON.stringify(row('film', 'a-film', { handle_seconds, speaker_similarity_min })));
  const ran = python([join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'),
    '--settings-record', join(work, 'person.json'), '--settings-record', join(work, 'film.json'), '--out', join(work, 'from-records')]);
  assert.equal(ran.status, 0, ran.stderr);
  const fromRecords = JSON.parse(readFileSync(join(work, 'from-records', 'grades.json'), 'utf8'));
  const fromFile = JSON.parse(readFileSync(join(work, 'out', 'grades.json'), 'utf8'));
  assert.deepEqual(fromRecords.settings, fromFile.settings, 'the film row\'s handle wins over the person row\'s');
  assert.deepEqual(Object.fromEntries(Object.entries(fromRecords.spans).map(([id, e]) => [id, [e.grade, e.reasons]])),
    Object.fromEntries(Object.entries(fromFile.spans).map(([id, e]) => [id, [e.grade, e.reasons]])));

  const alone = python([join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--settings-record', join(work, 'film.json'), '--out', join(work, 'film-only')]);
  assert.notEqual(alone.status, 0);
  assert.match(alone.stderr, /snr_db_min is missing/);

  writeFileSync(join(work, 'retired.json'), JSON.stringify(row('person', 'someone', settings, { status: 'retired' })));
  const retired = python([join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--settings-record', join(work, 'retired.json'), '--out', join(work, 'retired')]);
  assert.notEqual(retired.status, 0);
  assert.match(retired.stderr, /retired/);

  writeFileSync(join(work, 'other.json'), JSON.stringify(row('person', 'someone', settings, { tool: 'tool:another-tool' })));
  const other = python([join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--settings-record', join(work, 'other.json'), '--out', join(work, 'other')]);
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /tool:another-tool, not tool:grade-and-repair-speech-audio/);

  const both = python([join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--settings', join(work, 'settings.json'), '--settings-record', join(work, 'film.json'), '--out', join(work, 'both')]);
  assert.notEqual(both.status, 0, 'a settings file and a record are not mixed');
});

let take;
const takeReady = () => {
  if (take) return take;
  take = join(work, 'take');
  assert.equal(python([join(here, 'voice_take_fixture.py'), take]).status, 0, 'the take builds');
  return take;
};

test('check_voice_take.py flags the word with the click and writes one row per word', { skip: skipPitch }, () => {
  const t = takeReady();
  const ran = python([join(doWork, 'check_voice_take.py'), join(t, 'take.wav'), join(t, 'take.words.json')]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(last(ran).result.words, 5);
  const rows = JSON.parse(readFileSync(join(t, 'take.qc.json'), 'utf8'));
  const worst = rows.reduce((a, b) => (b.click > a.click ? b : a));
  assert.equal(worst.word, 'charlie', 'the click at 2.65 s is inside charlie');
  assert.ok(worst.flags.some((flag) => flag.startsWith('click')));
  for (const r of rows) assert.ok(['periodicity', 'max_jump_st', 'sec_per_letter_x_median', 'f0_iqr'].every((k) => k in r));
});

test('clean_voice_take_pauses.py silences the pauses, tick and hiss included, and leaves the words', { skip }, () => {
  const t = takeReady();
  const ran = python([join(doWork, 'clean_voice_take_pauses.py'), join(t, 'take.wav'), join(t, 'clean.wav')]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(last(ran).result.silenced >= 3, `silenced ${last(ran).result.silenced}`);
  const level = python(['-c', `import soundfile as sf, numpy as np, json
x, sr = sf.read(${JSON.stringify(join(t, 'clean.wav'))})
print(json.dumps({"pause": float(np.abs(x[int(1.6*sr):int(2.3*sr)]).max()), "word": float(np.abs(x[int(2.5*sr):int(2.8*sr)]).max())}))`]);
  const { pause, word } = JSON.parse(level.stdout);
  assert.equal(pause, 0, 'the pause with the tick is digital silence');
  assert.ok(word > 0.1, 'the word is kept');
});

test('tighten_word_starts.py moves each start to where the voice begins and keeps the script\'s spelling', { skip }, () => {
  const t = takeReady();
  const ran = python([join(doWork, 'tighten_word_starts.py'), join(t, 'take.wav'), join(t, 'take.words.json'), join(t, 'tight.json'), join(t, 'line.json')]);
  assert.equal(ran.status, 0, ran.stderr);
  const words = JSON.parse(readFileSync(join(t, 'tight.json'), 'utf8')).words;
  assert.equal(words[0].text, 'Alfa', 'the script\'s spelling');
  assert.ok(words[0].start >= 0.48 && words[0].start <= 0.51, `alpha starts at ${words[0].start}, where its voice does (0.5 s)`);
  assert.ok(words[2].start >= 2.38 && words[2].start <= 2.41, `charlie starts at ${words[2].start} (2.4 s)`);
  assert.equal(words[0].end, 0.9, 'ends stay');
});

test('the earshot checks run word by word and take by take, with the voice wanted in the person\'s words', { skip: skipPitch }, () => {
  const t = takeReady();
  const listened = python([join(doWork, 'listen_voice_take_words.py'), join(t, 'take.wav'), join(t, 'take.words.json'), '0', join(t, 'listen.json'), 'a made-up voice'], earshot);
  assert.equal(listened.status, 0, listened.stderr);
  const rows = JSON.parse(readFileSync(join(t, 'listen.json'), 'utf8'));
  assert.deepEqual(rows.map((r) => r.word), ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  assert.ok(rows.every((r) => 'p_real_dev' in r && 'z_glitch_dev' in r && 'z_clean' in r));
  mkdirSync(join(t, 'takes'), { recursive: true });
  writeFileSync(join(t, 'takes', 'take.wav'), readFileSync(join(t, 'take.wav')));
  writeFileSync(join(t, 'takes', 'take.words.json'), readFileSync(join(t, 'take.words.json')));
  const scored = python([join(doWork, 'score_voice_takes.py'), join(t, 'takes'), join(t, 'refs'), 'a made-up voice', join(t, 'scores.json')], earshot);
  assert.equal(scored.status, 0, scored.stderr);
  const scores = JSON.parse(readFileSync(join(t, 'scores.json'), 'utf8'));
  assert.deepEqual(Object.keys(scores), ['take.wav', 'ref.wav']);
  assert.ok(scores['take.wav'].compare && scores['take.wav'].wps > 0, 'a take is compared with the references and has words per second');
  assert.equal(scores['ref.wav'].compare, null, 'a reference is not compared with itself');
  assert.ok(Math.abs(scores['take.wav'].f0_median_hz - 130) < 10, `pitch ${scores['take.wav'].f0_median_hz} near the 130 Hz voice`);
});
