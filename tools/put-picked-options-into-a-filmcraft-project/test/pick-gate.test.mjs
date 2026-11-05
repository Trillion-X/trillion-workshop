// pick_gate.py against a throwaway film, a stand-in records door (stand-in-trillion.mjs) and a stand-in filmcraft-cli:
// it refuses without the person's own pick, applies with one, and logs what it did. Made-up films, options and words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stanceRecord, stanceRecordId } from '../../where-a-person-stands/do-work/where-a-person-stands.mjs';
import { artifactRef, foldWith } from '../../where-a-person-stands/do-work/artifact-ref.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, '..', 'do-work', 'pick_gate.py');
const BRIDGE = join(here, '..', 'do-work', 'stance-id-from-stdin.mjs');
const STAND_IN = join(here, 'stand-in-trillion.mjs');
chmodSync(STAND_IN, 0o755);

const FOLD = { lowercase: true, collapse_space: true };
const settingId = film => `record:setting:put-picked-options-into-a-filmcraft-project~film~${film}`;
const settingsFor = cli => ({
  protected_projects: ['filmcraft/*.fcproj'], allowed_option_folders: ['filmcraft/options'], picked_stances: ['agree'],
  option_kind: 'film-option', option_fold: FOLD, filmcraft_cli: cli, apply_log: 'applied.jsonl',
});
const settingRow = (film, settings, status = 'active') => ({ id: settingId(film), type: 'record:setting', value: {
  name: 'pick gate of a made-up film', tool: 'tool:put-a-picked-option-into-a-filmcraft-project', scope_kind: 'film', scope_id: film,
  settings: JSON.stringify(settings), from: 'made up for a test', status } });
const stand = (option, stance, extra = {}) => {
  const { id, ...value } = stanceRecord({ kind: 'film-option', text: option, fold: FOLD, stance, why: 'made-up words', answered_by: 'person', ...extra });
  return { id, type: 'stance', value: { id, ...value } };
};
const optionId = option => stanceRecordId('film-option', artifactRef({ text: option }, foldWith(FOLD)));

function world(records = []) {
  const film = join(mkdtempSync(join(tmpdir(), 'pick-gate-')), 'film-one');
  mkdirSync(join(film, 'filmcraft', 'options'), { recursive: true });
  writeFileSync(join(film, 'filmcraft', 'cut.fcproj'), '{}');
  writeFileSync(join(film, 'filmcraft', 'options', 'try.fcproj'), '{}');
  writeFileSync(join(film, 'ops.jsonl'), '{"id":"timeline.place","params":{}}\n');
  const cli = join(film, 'fake-filmcraft-cli');
  writeFileSync(cli, `#!/bin/sh\necho "$@" >> ${film}/cli-calls.txt\n`);
  chmodSync(cli, 0o755);
  const settings = settingsFor(cli);
  const door = join(film, 'door.json');
  writeFileSync(door, JSON.stringify({ records: [settingRow('film-one', settings), ...records] }));
  const run = (...args) => spawnSync('python3', [TOOL, '--film', film, ...args], {
    encoding: 'utf8', env: { ...process.env, TRILLION_BIN: STAND_IN, STAND_IN_RECORDS: door },
  });
  const apply = (option, project = join(film, 'filmcraft', 'cut.fcproj')) => run('apply', option, '--project', project, '--ops', join(film, 'ops.jsonl'));
  return { film, settings, run, apply, door };
}

test('an option with no stand (a recommended flag alone) is refused and nothing runs', () => {
  const { film, apply } = world();
  const result = apply('cp1-c1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no stand kept/);
  assert.equal(existsSync(join(film, 'cli-calls.txt')), false);
});

test('a disagree, a partly and a stand taken back are all refused', () => {
  const { apply } = world([stand('a', 'disagree'), stand('b', 'partly'), stand('c', null)]);
  for (const option of ['a', 'b', 'c']) assert.equal(apply(option).status, 1, option);
});

test('an agree applies headless on the project and logs it', () => {
  const { film, apply } = world([stand('a', 'agree')]);
  const result = apply('a');
  assert.equal(result.status, 0, result.stderr);
  const call = readFileSync(join(film, 'cli-calls.txt'), 'utf8');
  assert.match(call, /--project/);
  assert.match(call, /--save run/);
  assert.doesNotMatch(call, /--bridge/);
  const log = JSON.parse(readFileSync(join(film, 'applied.jsonl'), 'utf8').split('\n')[0]);
  assert.deepEqual([log.option_id, log.verdict, log.protected, log.exit], ['a', 'agree', true, 0]);
  assert.equal(log.verdict_decision_id, optionId('a'));
  assert.match(log.ops_hash, /^blake3:[0-9a-f]{64}$/);
});

test('a project inside an option folder is applied but logged as not protected', () => {
  const { film, apply } = world([stand('a', 'agree')]);
  assert.equal(apply('a', join(film, 'filmcraft', 'options', 'try.fcproj')).status, 0);
  assert.equal(JSON.parse(readFileSync(join(film, 'applied.jsonl'), 'utf8').split('\n')[0]).protected, false);
});

test('the same option typed another way is the same option (the fold of tools/where-a-person-stands)', () => {
  const { apply } = world([stand('Option  A', 'agree')]);
  assert.equal(apply('option a').status, 0);
});

test('a later disagree withdraws a pick: the record is read as it is now', () => {
  const picked = stand('a', 'agree');
  const { door, apply } = world([picked]);
  assert.equal(apply('a').status, 0);
  const { records } = JSON.parse(readFileSync(door, 'utf8'));
  writeFileSync(door, JSON.stringify({ records: records.map(r => (r.id === picked.id ? stand('a', 'disagree') : r)) }));
  assert.equal(apply('a').status, 1);
});

test('only the person counts: a stand kept by an AI is no pick', () => {
  const byAi = stand('a', 'agree');
  byAi.value.by = 'ai:someone';
  assert.equal(world([byAi]).apply('a').status, 1);
});

test('a record of another thing under this option\'s id is no pick', () => {
  const wrongPlace = { ...stand('other', 'agree'), id: optionId('a') };
  assert.equal(world([wrongPlace]).apply('a').status, 1);
});

test('--print shows the exact command and runs nothing', () => {
  const { film, run } = world([stand('a', 'agree')]);
  const result = run('apply', 'a', '--project', join(film, 'filmcraft', 'cut.fcproj'), '--ops', join(film, 'ops.jsonl'), '--print');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--save run/);
  assert.equal(existsSync(join(film, 'cli-calls.txt')), false);
});

test('an ops file outside the film is refused', () => {
  const { film, run } = world([stand('a', 'agree')]);
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'pick-gate-out-')), 'ops.jsonl');
  writeFileSync(elsewhere, '{}\n');
  const result = run('apply', 'a', '--project', join(film, 'filmcraft', 'cut.fcproj'), '--ops', elsewhere);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must live inside/);
});

test('check exits 0 for a pick and 1 for an option nobody picked', () => {
  const { run } = world([stand('a', 'agree')]);
  assert.equal(run('check', 'a').status, 0, run('check', 'a').stderr);
  assert.equal(run('check', 'zzz').status, 1);
});

test('rows prints where the person stands on every option of the kind, and nothing else', () => {
  const noise = { id: `stance:title:1f:${'0'.repeat(64)}`, type: 'stance', value: { kind: 'title', text: 'a title', stance: 'agree', by: 'person' } };
  const { run } = world([stand('a', 'agree'), stand('b', 'disagree'), noise]);
  const result = run('rows');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map(r => [r.option_id, r.verdict]).sort(), [['a', 'agree'], ['b', 'disagree']]);
});

test('no settings row for the film is refused with where to make it', () => {
  const { door, run } = world();
  writeFileSync(door, JSON.stringify({ records: [] }));
  const result = run('check', 'a');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /record:setting:put-picked-options-into-a-filmcraft-project~film~film-one/);
});

test('a retired settings row is refused, and --settings-record names another row', () => {
  const { door, run, settings } = world([stand('a', 'agree')]);
  const { records } = JSON.parse(readFileSync(door, 'utf8'));
  writeFileSync(door, JSON.stringify({ records: [settingRow('film-one', settings, 'retired'), settingRow('other-cut', settings), ...records.slice(1)] }));
  const refused = run('check', 'a');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /retired/);
  assert.equal(run('--settings-record', settingId('other-cut'), 'check', 'a').status, 0);
});

test('a settings row that lacks a needed setting is refused, naming it', () => {
  const { door, run, settings } = world([stand('a', 'agree')]);
  const { protected_projects: _, ...lacking } = settings;
  writeFileSync(door, JSON.stringify({ records: [settingRow('film-one', lacking), stand('a', 'agree')] }));
  const result = run('check', 'a');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lack protected_projects/);
});

test('a door that cannot be reached is a refusal, not a pick', () => {
  const { film } = world([stand('a', 'agree')]);
  const result = spawnSync('python3', [TOOL, '--film', film, 'check', 'a'], { encoding: 'utf8', env: { ...process.env, TRILLION_BIN: join(film, 'no-such-command') } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not read the person's records/);
});

test('the bridge names each option\'s stance record as tools/where-a-person-stands does', () => {
  const ran = spawnSync(process.execPath, [BRIDGE], { encoding: 'utf8', input: JSON.stringify({ kind: 'film-option', fold: FOLD, texts: ['Option  A', 'b'] }) });
  assert.equal(ran.status, 0, ran.stderr);
  const { ids } = JSON.parse(ran.stdout);
  assert.equal(ids['Option  A'].id, optionId('option a'));
  assert.equal(ids.b.artifact, artifactRef({ text: 'b' }, foldWith(FOLD)));
  const bad = spawnSync(process.execPath, [BRIDGE], { encoding: 'utf8', input: JSON.stringify({ kind: 'film-option', fold: FOLD, texts: 'b' }) });
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).error, /list of option ids/);
});
