// test/take-open-work-in-a-run.test.mjs
// The taker as a run the engine keeps (harness/take-open-work-in-a-run.mjs, tool:take-given-tasks-on-this-computer): the
// settings it is given are written where the taker reads them, with only its three holes filled, and the row that starts
// it names what the wake needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { keepRunSettings, runSettings, runValues } from '../harness/take-open-work-in-a-run.mjs';

const VALUES = { granted_program: '/Programs/the-ai', granted_work: '/Work', kept_home: '/Kept' };

test('only {granted_program}, {granted_work} and {kept_home} are filled, at any depth; every other hole is left for the taker', () => {
  const settings = {
    computer_name: 'A computer',
    working_folder: '{granted_work}',
    ais: [{ id: 'claude', command: ['{granted_program}', '-p', '{prompt}'] }],
    state: { note: '{kept_home}/notes and {program} stay {program}' },
    work_mcp: null,
    max_concurrent: 1,
  };
  assert.deepEqual(runSettings(settings, VALUES), {
    computer_name: 'A computer',
    working_folder: '/Work',
    ais: [{ id: 'claude', command: ['/Programs/the-ai', '-p', '{prompt}'] }],
    state: { note: '/Kept/notes and {program} stay {program}' },
    work_mcp: null,
    max_concurrent: 1,
  });
});

test('the three values come from the run\'s own flags, and a missing one is named', () => {
  assert.deepEqual(runValues(['--home', '/Kept', '--program', '/Programs/the-ai', '--work', '/Work']), VALUES);
  assert.throws(() => runValues(['--home', '/Kept', '--program', '/Programs/the-ai']), /--work/);
  assert.throws(() => runValues(['--home', '', '--program', 'x', '--work', 'y']), /--home/);
});

test('the settings are kept as this computer\'s take-open-work.computer.json in the taker\'s state folder, readable by its owner only', () => {
  const home = tempFolder(join(tmpdir(), 'taker-run-home-'));
  const path = keepRunSettings({ computer_name: 'A computer', chosen_ai: 'claude' }, home);
  const stateFolder = JSON.parse(readFileSync(new URL('../harness/take-open-work.json', import.meta.url), 'utf8')).state_folder.replace(/^~\//, '');
  assert.equal(path, join(home, stateFolder, 'take-open-work.computer.json'));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { computer_name: 'A computer', chosen_ai: 'claude' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('the taker names its computer as the kept settings say, so its agent id is the one it had when it ran by hand', async () => {
  const home = tempFolder(join(tmpdir(), 'taker-run-name-'));
  keepRunSettings({ computer_name: 'Desk Computer (2)', chosen_ai: 'claude' }, home);
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const { computerName, takerCard, readSettings } = await import('../harness/take-open-work.mjs');
    assert.equal(computerName(), 'Desk Computer (2)');
    assert.equal(takerCard(readSettings()).agent_id, 'take-open-work-desk-computer-2');
  } finally {
    process.env.HOME = saved;
  }
});

test('the row starts the run with its kept folder and grant, keeps it open, reaches only the task tools, and its wake asks for what the run needs', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
  const row = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:take-given-tasks-on-this-computer');
  assert.ok(row, 'the taker has a row');
  const { invoke } = row;
  assert.equal(invoke.kind, 'computer');
  assert.deepEqual(invoke.capabilities, ['start-a-program']);
  assert.equal(invoke.session.keep_open, true);
  assert.equal(invoke.kept_folder, true);
  const entry = invoke.argv[2];
  assert.ok(existsSync(new URL(`..${entry.slice(invoke.files.package_files[0].at.length)}`, import.meta.url)), `${entry} is a file the row lays out`);
  const flagValue = name => invoke.argv[invoke.argv.indexOf(name) + 1];
  assert.deepEqual(flagValue('--home'), { fill: { from: 'task', field: 'kept_folder' } });
  assert.deepEqual(flagValue('--program'), { fill: { from: 'task', field: 'grants.start-a-program.program' } });
  assert.deepEqual(flagValue('--work'), { fill: { from: 'task', field: 'grants.start-a-program.work' } });
  assert.deepEqual(invoke.records.runs.slice().sort(), ['tool:change-a-task', 'tool:finish-a-task', 'tool:run-sql-in-my-database', 'tool:take-a-task']);
  const taskRules = JSON.parse(readFileSync(new URL('../harness/take-open-work.json', import.meta.url), 'utf8')).tasks;
  for (const tool of [taskRules.take_tool, taskRules.move_tool, taskRules.finish_tool]) assert.ok(invoke.records.runs.includes(tool), `${tool} is a right of the run`);
  const [wake] = row.wakes;
  assert.deepEqual(wake.on, { running: {} });
  const schemaHas = path => path.split('.').reduce((schema, part) => schema?.properties?.[part] ?? (schema?.required?.includes(part) ? {} : undefined), row.input_schema) !== undefined;
  for (const path of wake.needs_input) assert.ok(schemaHas(path), `${path} is an input the row takes`);
});
