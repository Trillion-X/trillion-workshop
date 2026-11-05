// tools/ask-a-small-model-for-a-verdict: answering a check's `ask` questions with a model kept on this computer, and
// calibrating a person's ask rows on lines they ruled on (do-work/answer_with_a_downloaded_model.py and its rows in
// do-work/answer-with-a-downloaded-model.mjs). No model runs here: every answer comes from a stand-in in the ask or from a
// made-up answer cache, and every setting, row, line and path is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerAsks, calibrateAsks, readLineSet, runAnswerer } from '../do-work/answer-with-a-downloaded-model.mjs';
import { check } from '../../check-against-a-persons-rules-and-verdicts/do-work/rules-and-verdicts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ANSWERER = join(here, '..', 'do-work', 'answer_with_a_downloaded_model.py');
const PROBE = join(here, 'answer_with_a_downloaded_model_probe.py');
const empty = () => mkdtempSync(join(tmpdir(), 'answerer-'));

const FIT = { fail_good_share_at_most: 0.05, pass_bad_share_at_most: 0.1, usable_when: { auc_at_least: 0.75, bad_lines_at_least: 2, recall_at_least: 0.25, good_failed_or_uncertain_at_most: 0.35 } };
const SETTINGS = { frame: 'A line of copy:\n"{text}"', good_sets: ['kept'], example_good_sources: ['owner-ruling'], fit: FIT, batch: 4, consult_batch: 2, consult_bytes: 10 };
const yes = p => ({ no: Math.round((1 - p) * 1e5) / 1e5, yes: p });

const probe = (request, env = {}) => {
  const ran = spawnSync('python3', ['-I', PROBE], { input: JSON.stringify({ settings: SETTINGS, ...request }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: empty(), ...env } });
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
};
const answerer = (action, request, env = {}) => {
  const ran = spawnSync('python3', ['-I', ANSWERER, action], { input: typeof request === 'string' ? request : JSON.stringify(request), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: empty(), ...env } });
  return { code: ran.status, ...JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
};

// --- answering ------------------------------------------------------------------------------------------------------

test('a stand-in answers from the ask itself, its otherwise for any other text, and none when it has neither', () => {
  const model = { stand_in: { answers: { 'The fog thinks.': yes(0.9) }, otherwise: yes(0.1) } };
  const asks = [
    { question: 'Is it vague?', options: ['no', 'yes'], text: 'The fog thinks.', model },
    { question: 'Is it vague?', options: ['no', 'yes'], text: 'Ten people came.', model },
    { question: 'Is it vague?', options: ['no', 'yes'], text: 'Ten people came.', model: { stand_in: { answers: {} } } },
  ];
  const got = answerer('answer', { settings: SETTINGS, asks, mode: 'live' });
  assert.equal(got.code, 0, got.error);
  assert.deepEqual(got.result, [yes(0.9), yes(0.1), null]);
  const wrong = answerer('answer', { settings: SETTINGS, asks: [{ ...asks[0], model: { stand_in: { otherwise: { maybe: 1 } } } }] });
  assert.equal(wrong.code, 1);
  assert.match(wrong.error, /probability for each option/);
});

test('cached answers are found by what answers, the question and the framed line; cache mode never asks a model', () => {
  const folder = empty(), cache = join(folder, 'answers.jsonl');
  const framed = 'A line of copy:\n"The fog thinks."';
  writeFileSync(cache, [
    { a: '', q: 'Is it vague?', c: framed, p: yes(0.7) },
    { a: 'b3-of-a-made-up-adapter', q: 'Is it vague?', c: framed, p: yes(0.2) },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const settings = { ...SETTINGS, cache_file: cache };
  const ask = { question: 'Is it vague?', options: ['no', 'yes'], text: 'The fog thinks.' };
  const got = answerer('answer', { settings, mode: 'cache', asks: [ask, { ...ask, adapter: { name: 'made-up', blake3: 'b3-of-a-made-up-adapter' } }, { ...ask, text: 'Not cached.' }] });
  assert.equal(got.code, 0, got.error);
  assert.deepEqual(got.result, [yes(0.7), yes(0.2), null]);
});

test('a live answer with nowhere to keep it, an unknown mode, no settings, a bad request: each refused in words', () => {
  const ask = { question: 'Is it vague?', options: ['no', 'yes'], text: 'Not cached.' };
  assert.match(answerer('answer', { settings: SETTINGS, asks: [ask] }).error, /settings\.cache_file is required/);
  assert.match(answerer('answer', { settings: SETTINGS, asks: [ask], mode: 'sometimes' }).error, /mode must be live/);
  assert.match(answerer('answer', { asks: [ask] }).error, /settings is required/);
  assert.match(answerer('answer', 'not json').error, /one JSON object/);
  assert.match(answerer('answer', { settings: SETTINGS }).error, /asks is required/);
  assert.match(answerer('weigh', { settings: SETTINGS }).error, /answer or calibrate/);
  assert.match(answerer('answer', { settings: { ...SETTINGS, frame: undefined }, asks: [{ ...ask, model: { stand_in: {} } }] }).error, /settings\.frame is required/);
});

// --- what a model reads ---------------------------------------------------------------------------------------------

test('a line is shown in the frame, after its film context in a fixed order, and its own ruled line is never in view', () => {
  const lines = [
    { text: 'The fog thinks.', good: false, bad_for: ['vague'], source: 'owner-ruling' },
    { text: 'The fog thinks. It waits.', good: false, bad_for: ['vague'], source: 'owner-ruling' },
    { text: 'A cloud of maybe.', good: false, bad_for: ['vague'], source: 'owner-ruling' },
    { text: 'A cloud of maybe.', good: false, bad_for: ['other-law'], source: 'owner-ruling' },
    { text: 'Ten people came.', good: true, bad_for: [], source: 'owner-ruling' },
    { text: 'The door is red.', good: true, bad_for: [], source: 'a-helper' },
  ];
  const context = { spoken: 'we went in', after: 'Then it rained.', on_screen_with: [' 10 PM '], before: 'It was late.' };
  const [plain, placed, withExamples] = probe({
    probe: 'context', line_sets: { 'made-up-rulings': lines },
    asks: [
      { text: 'The fog thinks.' },
      { text: 'The fog thinks.', context },
      { text: 'The fog thinks.', examples: { items: 'calibration/made-up-rulings.json', bad_for: 'vague' } },
    ],
  }).result;
  assert.equal(plain, 'A line of copy:\n"The fog thinks."');
  assert.equal(placed, 'Where this line appears in the film:\nLine before it: "It was late."\nLine after it: "Then it rained."\n'
    + 'Other text on screen with it: "10 PM"\nSpoken while it is on screen: "we went in"\n\nA line of copy:\n"The fog thinks."');
  assert.equal(withExamples, 'Lines of film copy the author rejected:\n- "A cloud of maybe."\n\nLines of film copy the author approved:\n- "Ten people came."\n\nA line of copy:\n"The fog thinks."');
  const asOwn = probe({ probe: 'context', line_sets: { rulings: lines }, asks: [{ text: 'Ten people came.', examples: { items: 'rulings', bad_for: 'vague', good_sources: ['a-helper'] } }] }).result[0];
  assert.match(asOwn, /approved:\n- "The door is red."\n\n/);
  assert.match(probe({ probe: 'context', asks: [{ text: 'x', examples: { items: 'missing', bad_for: 'vague' } }] }).error, /line_sets has no set 'missing'/);
  assert.match(probe({ probe: 'context', asks: [{ text: 'x', examples: { yes: ['a'], no: ['b'] } }] }).error, /not a set of labelled lines/);
});

test('what answers an ask is part of its cache key: an adapter by BLAKE3, an MLX model at its one snapshot, a hosted name, a stand-in', () => {
  const root = empty();
  for (const sha of ['1111']) execFileSync('mkdir', ['-p', join(root, 'models--made-up--chat/snapshots', sha), join(root, 'models--made-up--two/snapshots/a'), join(root, 'models--made-up--two/snapshots/b')]);
  const settings = { ...SETTINGS, model_cache_root: root, mlx_snapshots: { 'made-up/two': 'b' } };
  const asks = [{}, { adapter: { name: 'x', blake3: 'abc' } }, { model: { mlx: 'made-up/chat' } }, { model: { mlx: 'made-up/two' } }, { model: { consult: 'some-host' } }, { model: { stand_in: {} } }]
    .map(extra => ({ text: 't', ...extra }));
  assert.deepEqual(probe({ probe: 'engine', settings, asks }).result, ['', 'abc', 'mlx:made-up/chat@1111', 'mlx:made-up/two@b', 'consult:some-host', 'stand-in']);
  assert.match(probe({ probe: 'engine', settings: { ...settings, mlx_snapshots: {} }, asks: [{ text: 't', model: { mlx: 'made-up/two' } }] }).error, /expected exactly one downloaded snapshot under .* found 2/);
  assert.match(probe({ probe: 'engine', settings: { ...settings, mlx_snapshots: { 'made-up/chat': '9999' } }, asks: [{ text: 't', model: { mlx: 'made-up/chat' } }] }).error, /one downloaded snapshot 9999 .* found 0/);
});

test('an adapter\'s folder is the one the ask names, else the setting\'s for its name, else refused', () => {
  const settings = { ...SETTINGS, adapters: { 'made-up-r1': '/models/adapters/made-up-r1' } };
  assert.equal(probe({ probe: 'adapter', settings, adapter: { name: 'made-up-r1', blake3: 'b' } }).result, '/models/adapters/made-up-r1');
  assert.equal(probe({ probe: 'adapter', settings, adapter: { path: '/elsewhere/a', blake3: 'b' } }).result, '/elsewhere/a');
  assert.match(probe({ probe: 'adapter', settings, adapter: { name: 'other', blake3: 'b' } }).error, /settings\.adapters has no folder for the adapter 'other'/);
});

test('the hosted route: calls bounded by line count and bytes, the prompt, and only well-formed answers kept', () => {
  assert.deepEqual(probe({ probe: 'parts', sizes: [3, 3, 3, 9, 20, 1] }).result, [[0, 1], [2], [3], [4], [5]]);
  const prompt = probe({ probe: 'consult-prompt', question: 'Is it vague?', options: ['no', 'yes'], texts: ['one', 'two'] }).result;
  assert.match(prompt, /in this order: \["no", "yes"\]\.\n\nQuestion: Is it vague\?\n\n### Line 1\none\n\n### Line 2\ntwo\n\nReply with only a JSON object/);
  const table = probe({ probe: 'consult-table', answer: 'Here: {"1": [3, 1], "2": [0.5], "3": [0, 0], "4": [-1, 2]} done', options: ['no', 'yes'], count: 5 }).result;
  assert.deepEqual(table, [{ no: 0.75, yes: 0.25 }, null, null, null, null]);
  assert.deepEqual(probe({ probe: 'consult-table', answer: 'no table', options: ['no', 'yes'], count: 1 }).result, [null]);
  assert.equal(probe({ probe: 'mlx-prompt', context: 'C', ask: { question: 'Q?', options: ['no', 'yes'] } }).result, 'C\n\nQuestion: Q?\nAnswer with one word: no or yes.');
});

test('the model is found in the cache this place reports, runs on the device it has, and no route is guessed', () => {
  const words = 'This place has not said where it keeps ai-command-center. Set AI_COMMAND_CENTER, or consult_route in this tool\'s settings.';
  const base = { repo: 'made-up/decider', snapshot: 'abc123' };
  const fromEnv = probe({ probe: 'place', settings: { ...SETTINGS, base_model: base } }, { HF_HUB_CACHE: '/models/hub' }).result;
  assert.equal(fromEnv.model, '/models/hub/models--made-up--decider/snapshots/abc123');
  assert.equal(fromEnv.device, 'cpu');
  assert.deepEqual(fromEnv.route, { refused: words });
  assert.equal(fromEnv.cache, null);
  const fromSetting = probe({ probe: 'place', settings: { ...SETTINGS, base_model: base, model_cache_root: '/elsewhere', device: 'mps', consult_route: '/routes/consult.py', cache_file: '/kept/answers.jsonl' } }, { HF_HUB_CACHE: '/models/hub', DECIDER_DEVICE: 'cuda' }).result;
  assert.deepEqual(fromSetting, { model: '/elsewhere/models--made-up--decider/snapshots/abc123', cache: '/kept/answers.jsonl', device: 'mps', route: '/routes/consult.py' });
  const fromPlace = probe({ probe: 'place' }, { HF_HOME: '/hf', DECIDER_DEVICE: 'cuda', AI_COMMAND_CENTER: '/acc' }).result;
  assert.deepEqual(fromPlace, { model: null, cache: null, device: 'cuda', route: '/acc/.claude/hooks/consult-model.py' });
});

test('the answerer names no home folder, install folder, fixed local port, model, person or adapter of its own', () => {
  const tie = /homedir\(\)\s*,\s*'dev\/|Path\.home\(\)\s*\/\s*"dev\/|\/opt\/homebrew\/|\/Users\/[^/]+\/|127\.0\.0\.1:\d+|localhost:\d+|device="mps"|decider-2b\/snapshots|Qwen\/|copy-laws/;
  for (const file of [ANSWERER, join(here, '..', 'do-work', 'answer-with-a-downloaded-model.mjs')]) {
    const found = readFileSync(file, 'utf8').split('\n').map((line, at) => [at + 1, line]).filter(([, line]) => tie.test(line));
    assert.deepEqual(found, [], file);
  }
});

// --- calibrating ----------------------------------------------------------------------------------------------------

const RULE = {
  id: 'made-up-vague', says: 'Say the plain thing.',
  ask: {
    question: 'Is this line vague?', options: ['no', 'yes'], fail: 'yes', calibration: { bad_from: ['vague'] },
    model: { stand_in: { answers: { 'Things happen.': yes(0.9), 'Stuff is good.': yes(0.3), 'It works somehow.': yes(0.8), 'Maybe later.': yes(0.7) }, otherwise: yes(0.05) } },
  },
};

test('calibrate on lines by set: good when a set the setting names holds them, a line scored by its worst sentence', () => {
  const lines = [
    { text: 'Things happen.', sets: ['made'], bad_for: ['vague'] },
    { text: 'Stuff is good. It works somehow.', sets: ['made'], bad_for: ['vague'] },
    { text: 'Maybe later.', sets: ['made'], bad_for: ['other'] },
    { text: 'The kettle boils in two minutes.', sets: ['kept'], bad_for: [] },
    { text: 'Ten people came.', sets: ['kept', 'made'], bad_for: [] },
    { text: 'The door is red.', sets: ['kept'], bad_for: [] },
  ];
  const got = answerer('calibrate', { settings: SETTINGS, rules: [RULE, { id: 'no-ask', words: ['x'] }], lines, mode: 'cache' });
  assert.equal(got.code, 0, got.error);
  const { date, ...found } = got.result['made-up-vague'];
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(got.result), ['made-up-vague']);
  assert.deepEqual(found, { status: 'usable', auc: 1, n_bad: 2, n_good: 3, fail_good_share_at_most: 0.05, t_pass: 0.05, t_fail: 0.05, recall: 1,
    good_failed_held_out: 0, good_failed_or_uncertain_held_out: 0, fpr: 0.05 });
});

test('calibrate on ruled lines: only the split asked for, only lines with context when asked, and the lines named', () => {
  const lines = [
    { text: 'Things happen.', good: false, bad_for: ['vague'], split: 'test', context: { after: 'Then.' } },
    { text: 'It works somehow.', good: false, bad_for: ['vague'], split: 'test', context: { before: 'Now.' } },
    { text: 'Maybe later.', good: false, bad_for: ['vague'], split: 'train' },
    { text: 'Ten people came.', good: true, bad_for: [], split: 'test', context: { after: 'Then.' } },
    { text: 'The door is red.', good: true, bad_for: [], split: 'test' },
  ];
  const all = answerer('calibrate', { settings: SETTINGS, rules: [RULE], lines, lines_name: 'made-up-rulings', split: 'test', mode: 'cache' }).result['made-up-vague'];
  assert.equal(all.n_bad, 2);
  assert.equal(all.n_good, 2);
  assert.equal(all.lines, 'made-up-rulings split=test');
  const contextOnly = answerer('calibrate', { settings: SETTINGS, rules: [RULE], lines, split: 'test', context_only: true, fpr: 0.2, mode: 'cache' }).result['made-up-vague'];
  assert.equal(contextOnly.n_good, 1);
  assert.equal(contextOnly.fpr, 0.2);
  const tooFew = answerer('calibrate', { settings: SETTINGS, rules: [RULE], lines: lines.slice(2), mode: 'cache' }).result['made-up-vague'];
  assert.deepEqual(tooFew, { status: 'unseparable', reason: 'only 1 bad lines and 2 good lines with answers' });
  assert.match(answerer('calibrate', { settings: { ...SETTINGS, fit: undefined }, rules: [RULE], lines }).error, /settings\.fit is required/);
  assert.match(answerer('calibrate', { settings: SETTINGS, rules: [RULE] }).error, /rules and lines are required/);
});

// --- the rows, through the person's records door --------------------------------------------------------------------

const SETTING_ID = 'record:setting:ask-a-small-model-for-a-verdict~person~made-up-person';
function door(records) {
  const held = new Map(records.map(record => [record.id, record]));
  return {
    reads: [],
    async read(type, id) { this.reads.push(id); const found = held.get(id); return found && found.type === type ? found.value : null; },
    async *list({ type, where = {} }) {
      for (const record of held.values()) {
        if (record.type === type && Object.entries(where).every(([field, value]) => JSON.stringify(record.value[field]) === JSON.stringify(value))) yield record;
      }
    },
  };
}
const settingRow = (settings = SETTINGS) => ({ id: SETTING_ID, type: 'record:setting', value: { name: 'made up', tool: 'ask-a-small-model-for-a-verdict', scope_kind: 'person', scope_id: 'made-up-person', settings, status: 'active' } });
const lineRow = (set, at, line) => ({ id: `record:check:labelled-line-${set}-${at}`, type: 'record:check', value: { kind: 'labelled-line', part_of: ['made-up-vague'], set, at, ...line } });
const RECORDS = [
  settingRow(),
  { id: 'record:check:made-up-vague', type: 'record:check', value: { kind: 'check', part_of: 'made-up-branch', says: RULE.says, ask: RULE.ask } },
  { id: 'record:check:made-up-words', type: 'record:check', value: { kind: 'check', part_of: 'made-up-branch', words: ['zorblax'] } },
  lineRow('made-up-rulings', 1, { text: 'It works somehow.', good: false, bad_for: ['vague'], split: 'real', source: 'owner-ruling', copy_kind: 'title' }),
  lineRow('made-up-rulings', 0, { text: 'Things happen.', good: false, bad_for: ['vague'], split: 'real', source: 'owner-ruling' }),
  lineRow('made-up-rulings', 2, { text: 'Ten people came.', good: true, bad_for: [], split: 'real', source: 'owner-ruling' }),
  lineRow('made-up-rulings', 3, { text: 'The door is red.', good: true, bad_for: [], split: 'real', source: 'owner-ruling' }),
];

test('a set of labelled lines is read in its order, each line as it was before it moved', async () => {
  const lines = await readLineSet(door(RECORDS), 'made-up-rulings');
  assert.deepEqual(lines.map(line => line.text), ['Things happen.', 'It works somehow.', 'Ten people came.', 'The door is red.']);
  assert.deepEqual(lines[1], { text: 'It works somehow.', good: false, bad_for: ['vague'], split: 'real', source: 'owner-ruling', kind: 'title' });
  await assert.rejects(readLineSet(door(RECORDS), 'none-such'), /no labelled lines in the set none-such/);
});

test('answerAsks reads the settings through tools/settings and the examples\' lines through the door', async () => {
  const records = door(RECORDS);
  const asks = [{ question: 'Is it vague?', options: ['no', 'yes'], text: 'Stuff.', examples: { items: 'made-up-rulings', bad_for: 'vague' },
    model: { stand_in: { answers: { Stuff: yes(1) }, otherwise: yes(0.4) } } }];
  assert.deepEqual(await answerAsks({ settings_record: SETTING_ID, asks }, { door: records }), [yes(0.4)]);
  assert.deepEqual(records.reads, [SETTING_ID]);
  await assert.rejects(answerAsks({ asks }, { door: records }), /settings_record is required/);
  await assert.rejects(answerAsks({ settings_record: 'record:setting:another-tool~person~p', asks }, { door: records }), /another-tool/);
  await assert.rejects(answerAsks({ settings_record: SETTING_ID }, { door: records }), /asks is required/);
  await assert.rejects(answerAsks({ settings_record: SETTING_ID, asks }, { door: door([{ ...settingRow(), value: { ...settingRow().value, status: 'retired' } }, ...RECORDS.slice(1)]) }));
});

test('calibrateAsks reads the ask rows by id and the lines by set, and answers the fit for each row', async () => {
  const records = door(RECORDS);
  const got = await calibrateAsks({ settings_record: SETTING_ID, rules: ['made-up-vague'], lines: 'made-up-rulings', split: 'real', mode: 'cache' }, { door: records });
  assert.equal(got['made-up-vague'].status, 'usable');
  assert.equal(got['made-up-vague'].lines, 'made-up-rulings split=real');
  assert.ok(records.reads.includes('record:check:made-up-vague'));
  await assert.rejects(calibrateAsks({ settings_record: SETTING_ID, rules: ['made-up-words'], lines: 'made-up-rulings' }, { door: records }), /has no ask/);
  await assert.rejects(calibrateAsks({ settings_record: SETTING_ID, rules: ['gone'], lines: 'made-up-rulings' }, { door: records }), /no check row gone/);
  await assert.rejects(calibrateAsks({ settings_record: SETTING_ID, rules: [], lines: 'x' }, { door: records }), /rules is required/);
  await assert.rejects(calibrateAsks({ settings_record: SETTING_ID, rules: ['made-up-vague'] }, { door: records }), /lines is required/);
});

test('runAnswerer throws the answerer\'s own words', async () => {
  await assert.rejects(runAnswerer('answer', { settings: SETTINGS, asks: [{ question: 'q', options: ['no', 'yes'], text: 'x' }] }), /settings\.cache_file is required/);
});

// --- which ask rows a unit reaches (moved from the copy gate's decider-kinds test) --------------------------------

const ASK = { question: 'Is it vague?', options: ['no', 'yes'], fail: 'yes', at_most: 'uncertain', calibration: { status: 'usable', t_fail: 0.9 } };
const KIND_RULES = [
  { id: 'made-up-words', words: ['zorblax'], says: 'No zorblax.' },
  { id: 'ask-one', kinds: ['narrator', 'title'], ask: ASK },
  { id: 'ask-two', kinds: ['title', 'caption'], ask: ASK },
];
const asked = unit => check([{ where: 'test', ...unit }], KIND_RULES).questions;

test('every ask row a person keeps for copy declares the kinds it judges (made-up rows here; the person\'s own are checked at readback)', () => {
  for (const rule of KIND_RULES.filter(row => row.ask)) assert.ok(Array.isArray(rule.kinds) && rule.kinds.includes('title'), rule.id);
});
test('a title reaches every ask row that lists titles', () => {
  assert.deepEqual(asked({ text: 'A plain title.', kind: 'title' }).map(question => question.rule), ['ask-one', 'ask-two']);
});
test('a plan JSON reaches no ask row', () => {
  const view = { events: [{ type: 'pause', at: 0 }] };
  assert.deepEqual(asked({ text: JSON.stringify(view), kind: 'plan', view }), []);
});
test('a kind no ask row lists gets no question, even as text', () => {
  assert.deepEqual(asked({ text: 'Some words.', kind: 'plan-notes' }), []);
});
