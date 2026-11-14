import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeCall, writtenPaths } from '../do-work/check-where-work-is-kept.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'do-work', 'check-where-work-is-kept.mjs');

// Rules of the shape the check row record:check:work-is-kept-in-trillion-not-on-disk carries; the repository and
// list names are made up for the test.
const RULES = {
  source_repositories: ['example-owner/example-tools'],
  scratch: '.git/scratch',
  new_files_refused: [{ why: 'Markdown note', pattern: '\\.md$', except: '(^|/)(README|CONTRIBUTING|CHANGELOG)\\.md$', list: 'list:notes' }],
  list_copies: [{ folder: '~/kept-lists/notes', list: 'list:notes' }],
  list_copy_sync: 'read-list-view\\.mjs[^\\n]*--refresh',
  refused_places: [
    { place: '/tmp', why: 'a temporary file, outside every repository', list: 'list:notes' },
    { place: '/private/var/folders', why: 'a temporary file, outside every repository', list: 'list:notes' },
    { place: '/var/folders', why: 'a temporary file, outside every repository', list: 'list:notes' },
    { place: '~', why: 'a file in the home folder, outside every repository', list: 'list:notes' },
    { place: '~/.orchestra', why: 'the old orchestra folder', list: 'list:notes' },
    { place: '~/.orchestra/data', why: 'the old orchestra data folder', list: 'list:data' },
    { place: '~/.claude/**/memory', why: 'a Claude memory file', list: 'list:memories' },
  ],
  lists: {
    'list:notes': { type: 'record:note', value: { name: '{name}', text: '<what you were writing>' } },
    'list:memories': { type: 'record:memory', value: { says: '<what to remember>' } },
    'list:data': { type: 'record:data', value: { from: '{file}', value: '<the data>' } },
  },
  default_list: 'list:notes',
};

function world(t) {
  const base = mkdtempSync(join(tmpdir(), 'check-where-work-is-kept-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const root = join(home, 'code', 'example-tools');
  mkdirSync(root, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@example.test:example-owner/example-tools.git');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'reader.mjs'), 'x\n');
  writeFileSync(join(root, '.gitignore'), 'build/\n');
  git('add', '.');
  return { home, root };
}

const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('the fixtures that pass: tracked source, a new source file, the scratch, a README, the list-copy sync, /dev/null', async (t) => {
  const { home, root } = world(t);
  for (const call of [
    write(join(root, 'src', 'reader.mjs')),
    { tool_name: 'Edit', tool_input: { file_path: join(root, 'src', 'reader.mjs') } },
    write(join(root, 'src', 'writer.mjs')),
    write(join(root, 'tools', 'new-tool', 'README.md')),
    write(join(root, '.git', 'scratch', 'plan.json')),
    bash('mkdir -p .git/scratch/run && git archive HEAD | tar -x -C .git/scratch/run'),
    bash('node tools/read-a-list-view/do-work/read-list-view.mjs --config c.json --refresh list:notes'),
    bash('npm test 2>/dev/null | tail -5 > /dev/stderr'),
    bash('git status && git log --oneline -3'),
  ]) {
    const result = await judgeCall({ call, root, rules: RULES, home });
    assert.equal(result.valid, true, JSON.stringify(call));
    assert.deepEqual(result.warnings, [], JSON.stringify(call));
  }
});

test('the fixtures that refuse: /tmp, home, an orchestra folder, its data, Claude memory, a new .md note, a list copy', async (t) => {
  const { home, root } = world(t);
  const cases = [
    [write('/tmp/plan.md'), 'list:notes', 'temporary'],
    [bash('echo plan > ~/plan.txt'), 'list:notes', 'home folder'],
    [bash('cat > ~/.orchestra/state.json <<EOF\n{"a": 1}\nEOF'), 'list:notes', 'orchestra folder'],
    [bash('cp out.json ~/.orchestra/data/'), 'list:data', 'orchestra data'],
    [write(join(home, '.claude', 'projects', 'example', 'memory', 'MEMORY.md')), 'list:memories', 'Claude memory'],
    [write(join(root, 'notes', 'what-i-learned.md')), 'list:notes', 'Markdown note'],
    [write(join(home, 'kept-lists', 'notes', 'Avery', 'plan.md')), 'list:notes', 'list-copy sync'],
    [bash('f=$(mktemp) && curl -sSo "$f" https://example.test/x'), 'list:notes', 'temporary'],
  ];
  for (const [call, list, why] of cases) {
    const result = await judgeCall({ call, root, rules: RULES, home });
    assert.equal(result.valid, false, JSON.stringify(call));
    assert.equal(result.refused[0].list, list, JSON.stringify(call));
    assert.match(result.refused[0].why, new RegExp(why), JSON.stringify(call));
    const [record] = result.refused[0].write.records;
    assert.equal(record.type, RULES.lists[list].type);
    assert.ok(record.id.startsWith(`${record.type}:`));
  }
});

test('the refusal names the list and the exact records:write shape, and the command line exits 2', (t) => {
  const { home, root } = world(t);
  const ran = spawnSync(process.execPath, [SCRIPT, '--root', root, '--file-path', '/tmp/release-plan.md', '--command', '', '--rules-json', JSON.stringify(RULES)],
    { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(ran.status, 2);
  assert.match(ran.stderr, /never onto disk/);
  assert.match(ran.stderr, /Keep it in list:notes instead: records:write \{"records":\[\{"id":"record:note:release-plan","type":"record:note","value":\{"name":"release-plan","text":"<what you were writing>"\}\}\]\}/);
  const passing = spawnSync(process.execPath, [SCRIPT, '--root', root, '--file-path', '', '--command', 'git status', '--rules-json', JSON.stringify(RULES)], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(passing.status, 0);
  assert.equal(passing.stderr, '');
});

test('a Bash command is read for every way it writes: redirects, tee, cp, mv, mkdir, touch, dd, curl, cd', () => {
  const paths = (command) => writtenPaths(bash(command), { cwd: '/w', home: '/h' }).map((one) => one.path);
  assert.deepEqual(paths('echo hi>notes.md 2>&1'), ['/w/notes.md']);
  assert.deepEqual(paths('ls | tee -a ~/log.txt /tmp/x'), ['/h/log.txt', '/tmp/x']);
  assert.deepEqual(paths('cd /tmp && mkdir -p a/b && touch c'), ['/tmp/a/b', '/tmp/c']);
  assert.deepEqual(paths('cp -r src $HOME/backup; mv a b c/'), ['/h/backup', '/w/c']);
  assert.deepEqual(paths('dd if=/dev/zero of=/var/x bs=1'), ['/var/x']);
  assert.deepEqual(paths('curl -sSLo out.json https://example.test/z && curl -O https://example.test/f.tgz?x=1'), ['/w/out.json', '/w/f.tgz']);
  assert.deepEqual(paths("git commit -m \"$(cat <<'EOF'\nFix (the) reader > /tmp/y\nEOF\n)\""), []);
  assert.deepEqual(paths('echo "a > b"'), []);
});

test('an unplaced path goes to the classifier: its answer decides, and a failure passes with a warning', async (t) => {
  const { home, root } = world(t);
  const classifier = { rubric: { id: 'made-up' }, timeout_seconds: 5, pass_answers: ['source'], lists_by_answer: { note: 'list:notes' } };
  const rules = { ...RULES, classifier };
  const asked = [];
  const answering = (answer) => async (request) => { asked.push(request); return { verdict: { answer } }; };
  const passed = await judgeCall({ call: write('/srv/app/config.toml'), root, rules, home, ask: answering('source') });
  assert.equal(passed.valid, true);
  assert.match(asked[0].content, /path written: \/srv\/app\/config\.toml/);
  assert.deepEqual(asked[0].rubric, classifier.rubric);
  const refused = await judgeCall({ call: write('/srv/app/notes.txt'), root, rules, home, ask: answering('note') });
  assert.equal(refused.refused[0].list, 'list:notes');
  const ignored = await judgeCall({ call: write(join(root, 'build', 'out.js')), root, rules, home, ask: answering('note') });
  assert.equal(ignored.valid, false, 'a file the repository ignores is not its source; the classifier read it');
  const broken = await judgeCall({ call: write('/srv/app/x'), root, rules, home, ask: async () => ({ error: 'the model did not answer within 5 s' }) });
  assert.equal(broken.valid, true);
  assert.match(broken.warnings[0], /could not judge it \(the model did not answer within 5 s\), so it passed/);
  const none = await judgeCall({ call: write('/srv/app/x'), root, rules: RULES, home });
  assert.equal(none.valid, true);
  assert.match(none.warnings[0], /no classifier is set/);
});

test('the classifier is the Workshop model tool, given a timeout: a model that hangs passes with a warning', async (t) => {
  const { home, root } = world(t);
  const server = createServer(() => {}); // takes the request and never answers
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const rubric = { id: 'where-is-it-kept', question: 'Is this written path source code?', answer_shape: { kind: 'true-or-false' }, accept_when_answer_in: [true],
    calibration: [{ content: 'path written: /srv/app/main.rs', expect: true }, { content: 'path written: /srv/app/notes.txt', expect: false }] };
  const providers = [{ via: 'locally-served', endpoint: `http://127.0.0.1:${server.address().port}`, timeout_seconds: 30, protocol: 'ollama' }];
  const started = Date.now();
  const ran = spawnSync(process.execPath, [SCRIPT, '--root', root, '--file-path', '/srv/app/x', '--rules-json',
    JSON.stringify({ ...RULES, classifier: { rubric, providers, timeout_seconds: 2 } })], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.ok(Date.now() - started < 15000);
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stderr, /passed with warnings/);
  assert.match(ran.stderr, /did not answer within 2 s/);
});

test('as the Workshop tool: rules and the call on stdin, the refusal a result on the last line', (t) => {
  const { home, root } = world(t);
  const ran = spawnSync(process.execPath, [SCRIPT, '--root', root, '--input-on-stdin'],
    { input: JSON.stringify({ rules: RULES, call: write('/tmp/kept-plan.md') }), encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(ran.status, 0);
  const { result } = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.equal(result.valid, false);
  assert.equal(result.refused[0].write.records[0].id, 'record:note:kept-plan');
  const none = spawnSync(process.execPath, [SCRIPT, '--root', root, '--input-on-stdin'], { input: '{}', encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stdout, /give rules/);
});

test('a checkout with no origin that the rules name by its folder holds source: tracked files pass, a new file a row refuses is refused', async (t) => {
  const { home } = world(t);
  const plane = join(home, 'code', 'control-plane');
  mkdirSync(join(plane, 'notes', 'old'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', plane, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(plane, 'hook.py'), 'x\n');
  writeFileSync(join(plane, 'notes', 'old', 'kept.md'), 'x\n');
  git('add', '.');
  const rules = { ...RULES, source_checkouts: [{ path: '~/code/control-plane', name: 'control-plane' }],
    new_files_refused: [...RULES.new_files_refused, { why: 'note in the notes folder', pattern: '^notes/', list: 'list:notes' }] };
  for (const call of [write(join(plane, 'hook.py')), write(join(plane, 'src.py')), write(join(plane, 'notes', 'old', 'kept.md'))]) {
    const result = await judgeCall({ call, root: plane, rules, home });
    assert.equal(result.valid, true, JSON.stringify(call));
  }
  const refused = await judgeCall({ call: write(join(plane, 'notes', 'new.json')), root: plane, rules, home });
  assert.equal(refused.valid, false);
  assert.equal(refused.refused[0].list, 'list:notes');
  assert.match(refused.refused[0].why, /control-plane/);
  const unnamed = await judgeCall({ call: write(join(plane, 'hook.py')), root: plane, rules: RULES, home });
  assert.equal(unnamed.valid, false, 'without source_checkouts the same checkout is the home folder');
});
