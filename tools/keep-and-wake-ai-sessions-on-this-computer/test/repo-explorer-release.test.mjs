import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readFileSync } from 'node:fs';
import { latestRelease, planFrom, repoExplorer } from '../src/repo-explorer.mjs';

const enc = value => new TextEncoder().encode(value);
const dec = value => new TextDecoder().decode(value);
const ok = (stdout = '') => ({ code: 0, stdout: enc(stdout), stderr: new Uint8Array() });
const bad = (stderr, code = 1) => ({ code, stdout: new Uint8Array(), stderr: enc(stderr) });
const SHA = 'c0ffee'.padEnd(40, '0');
const ASSET = 'gridcraft-1.2.0-linux-x86_64.tar.gz';
const BASE = 'https://github.com/storytold/gridcraft/releases/download/v1.2.0';
const element = (name, attributes, inner = '') => ['<', name, attributes ? ` ${attributes}` : '', '>', inner, '</', name, '>'].join('');

const RELEASE = {
  tag_name: 'v1.2.0',
  assets: [
    { name: ASSET, size: 3200000, browser_download_url: `${BASE}/${ASSET}` },
    { name: 'gridcraft-1.2.0-macos-arm64.tar.gz', size: 4100000, browser_download_url: `${BASE}/gridcraft-1.2.0-macos-arm64.tar.gz` },
    { name: 'elsewhere.bin', size: 1, browser_download_url: 'https://evil.example/elsewhere.bin' },
  ],
};
const assetsPage = () => element('ul', '', [ASSET, 'gridcraft-1.2.0-macos-arm64.tar.gz'].map((name, index) => element('li', '', element('a', `href="/storytold/gridcraft/releases/download/v1.2.0/${name}"`, name) + element('span', '', index ? '4.1 MB' : '3.2 MB'))).join('')
  + element('li', '', element('a', 'href="/storytold/gridcraft/archive/refs/tags/v1.2.0.zip"', 'Source code (zip)')));

// mode: 'api' (REST answers), 'limited' (REST refuses with 403, the public pages answer), 'none' (no release).
function github(mode, calls = []) {
  return async url => {
    calls.push(url);
    const api = url.startsWith('https://api.github.com/');
    if (api && mode === 'limited') return new Response('rate limit', { status: 403 });
    if (url === 'https://github.com/storytold/gridcraft') return new Response(`{"defaultBranch":"main","currentOid":"${SHA}","license":{"spdxId":"Apache-2.0"}}`);
    if (url.endsWith('/repos/storytold/gridcraft')) return Response.json({ default_branch: 'main', license: { spdx_id: 'Apache-2.0' } });
    if (url.includes('/commits/main')) return Response.json({ sha: SHA });
    if (api && url.endsWith('/releases/latest')) return mode === 'none' ? new Response('none', { status: 404 }) : Response.json(RELEASE);
    if (url === 'https://github.com/storytold/gridcraft/releases/latest') return new Response(element('a', 'href="/storytold/gridcraft/releases/tag/v1.2.0"', 'v1.2.0'));
    if (url === 'https://github.com/storytold/gridcraft/releases/expanded_assets/v1.2.0') return new Response(assetsPage());
    return new Response('missing', { status: 404 });
  };
}

// One stand-in container per task id, each with its own files and folders. `program(argv, box, options)` is what the
// tool does when run; a setup command that downloads ('curl') puts the program in the container, and a restore from the
// kept files (tar) does too.
function world(program) {
  const log = [];
  const boxes = new Map();
  const sandboxFor = id => {
    if (!boxes.has(id)) boxes.set(id, { id, files: new Map(), dirs: new Set(), bin: false });
    const box = boxes.get(id);
    return {
      start: async ({ internet }) => { log.push({ id, start: internet }); },
      place: async (path, stream) => { box.files.set(path, new Uint8Array(await new Response(stream).arrayBuffer())); log.push({ id, placed: path }); },
      stop: async () => { log.push({ id, stop: true }); },
      exec: async (argv, options = {}) => {
        log.push({ id, argv, cwd: options.cwd, stdin: options.stdin ? dec(options.stdin) : null });
        const line = argv.join(' ');
        if (argv[0] === 'tar') { box.bin = true; return ok(); }
        if (argv[0] === 'node' || argv[0] === 'touch' || line.includes('tar xzf /work/.repository.tar.gz')) return ok();
        if (argv[0] === 'mkdir') { argv.slice(2).forEach(folder => box.dirs.add(folder)); return ok(); }
        if (argv[0] === 'rm') { argv.slice(3).forEach(path => box.files.delete(path)); return ok(); }
        if (argv[0] === 'stat') { const file = box.files.get(argv.at(-1)); return file ? ok(`${file.length}\n`) : bad('', 1); }
        if (argv[0] === 'find') { const under = [...box.files].filter(([path, bytes]) => path.startsWith(`${argv[1]}/`) && bytes.length); return ok(under.map(([path]) => `${path}\0`).join('')); }
        if (argv[0] === 'sh' && argv[1] === '-c') {
          const script = argv[2];
          if (script.startsWith('ls -la')) return ok('=== workspace members\ncrates/gridcraft\n=== README.md\nA spreadsheet tool');
          if (script === 'test -s "$1"') return (box.files.get(argv[4])?.length ?? 0) > 0 ? ok() : bad('', 1);
          if (script.startsWith('test -n')) return [...box.files].some(([path, bytes]) => path.startsWith(`${argv[4]}/`) && bytes.length) ? ok() : bad('', 1);
          if (script.startsWith('set -e; cd /;')) return { code: 0, stdout: enc('kept files'), stderr: new Uint8Array() };
          if (script.startsWith('curl')) { box.bin = true; return ok(); }
          return script.startsWith('fail') ? bad('no such command') : ok();
        }
        return program(argv, box, options);
      },
    };
  };
  return { log, boxes, sandboxFor };
}

// gridcraft-cli writes the workbook it is told to, if the folder exists, and says so.
const gridcraft = (argv, box) => {
  if (argv[0] !== './bin/gridcraft-cli' || !box.bin) return bad('not found', 127);
  const out = argv[argv.indexOf('--out') + 1];
  if (!box.dirs.has('/out')) return bad('no such folder /out');
  box.files.set(out, enc('xlsx bytes'));
  return ok('wrote budget.xlsx\n');
};
const DOWNLOAD = `curl -fsSL ${BASE}/${ASSET} | tar xz -C bin --strip-components=2`;
const GOOD = { setup: [DOWNLOAD], argv: ['./bin/gridcraft-cli', 'run', '--sample', { input: 'sample' }, '--out', '/out/budget.xlsx'], keep: ['bin'], outputs: [{ name: 'workbook', path: '/out/budget.xlsx' }], why: 'download the release' };
const SETTINGS = { planner: { model: 'planner' }, max_rounds: 3, unknown_licence_class: 'licence:none', tool_placement: 'placement:container', kept_paths: ['/work'], kept_changes_under: ['/usr/local'], max_kept_bytes: 1000 };
const REQUEST = { repo_url: 'https://github.com/storytold/gridcraft', job: 'Make a budget spreadsheet', sample_input: { sample: 'budget' }, expect_contains: 'wrote budget.xlsx' };

function explorer({ program = gridcraft, mode = 'api', replies, calls }) {
  const sandboxes = world(program);
  const prompts = [];
  const stored = new Map();
  const explore = repoExplorer({
    sandboxFor: sandboxes.sandboxFor,
    licenceClasses: async () => [{ id: 'licence:permissive', licences: ['Apache-2.0'], allowed_placements: ['placement:container'], store_bytes: true }],
    plan: async prompt => { prompts.push(prompt); return replies.shift(); },
    putBytes: async (fingerprint, bytes) => { stored.set(fingerprint, bytes); },
    fetchBytes: github(mode, calls),
  });
  const run = (input = REQUEST, settings = SETTINGS, files = null) => explore({ invocation: { settings, input }, task: { task_id: 'task_x' }, ...(files ? { files } : {}) });
  return { ...sandboxes, prompts, stored, run };
}

test('the planner sees the latest release files from the REST API, capped, and only those on github.com', async () => {
  const world = explorer({ replies: [JSON.stringify(GOOD)] });
  const result = await world.run();
  const prompt = world.prompts[0];
  assert.match(prompt, /--- ready-built release files \(latest release v1\.2\.0; prefer downloading the one for linux x86_64 in setup over compiling\) ---/);
  assert.ok(prompt.includes(`${ASSET} (3.2 MB) ${BASE}/${ASSET}`));
  assert.ok(!prompt.includes('evil.example'), 'an asset address off github.com is not offered');
  assert.match(prompt, /negative|none when the tool runs afterwards/);
  assert.match(prompt, /"keep": \["bin"\]/);
  assert.match(prompt, /"outputs": \[/);
  const context = world.log.find(entry => entry.argv?.[2]?.startsWith('ls -la'));
  assert.match(context.argv[2], /ls -d crates\/\* apps\/\* packages\/\* 2>\/dev\/null \| head -60/);
  assert.ok(prompt.includes('=== workspace members\ncrates/gridcraft'));
  // A cap in the row's settings limits how many files are shown.
  const capped = explorer({ replies: [JSON.stringify(GOOD)] });
  await capped.run(REQUEST, { ...SETTINGS, max_release_assets: 1 });
  assert.ok(capped.prompts[0].includes(ASSET) && !capped.prompts[0].includes('macos-arm64'));
  assert.deepEqual(result.descriptor.provenance, { repository: 'https://github.com/storytold/gridcraft', commit: SHA, licence: 'Apache-2.0', explored_with: 'download the release', release: { tag: 'v1.2.0', assets: [ASSET] } });
});

test('when GitHub refuses the REST API the release files come from the public release pages', async () => {
  const calls = [];
  const world = explorer({ mode: 'limited', replies: [JSON.stringify(GOOD)], calls });
  const result = await world.run();
  assert.ok(calls.includes('https://github.com/storytold/gridcraft/releases/latest'));
  assert.ok(calls.includes('https://github.com/storytold/gridcraft/releases/expanded_assets/v1.2.0'));
  assert.ok(world.prompts[0].includes(`${ASSET} (3.2 MB) ${BASE}/${ASSET}`));
  assert.ok(world.prompts[0].includes('gridcraft-1.2.0-macos-arm64.tar.gz (4.1 MB)'));
  assert.ok(!world.prompts[0].includes('Source code'), 'source archives are not release files');
  assert.deepEqual(result.descriptor.provenance.release, { tag: 'v1.2.0', assets: [ASSET] });
  assert.deepEqual(await latestRelease({ owner: 'storytold', repo: 'gridcraft', fetchBytes: github('limited'), limit: 1 }), { tag: 'v1.2.0', assets: [{ name: ASSET, size: 3200000, url: `${BASE}/${ASSET}` }] });
});

test('a repository with no release gets no release section, and a plan that builds from source records no release', async () => {
  const world = explorer({ mode: 'none', replies: [JSON.stringify({ setup: ['pip install .'], argv: ['./bin/gridcraft-cli', 'run', '--sample', { input: 'sample' }, '--out', '/out/budget.xlsx'], outputs: [{ name: 'workbook', path: '/out/budget.xlsx' }] })], program: (argv, box) => gridcraft(argv, { ...box, bin: true }) });
  const result = await world.run();
  assert.ok(!world.prompts[0].includes('ready-built release files'));
  assert.equal(result.descriptor.provenance.release, undefined);
  assert.equal(await latestRelease({ owner: 'storytold', repo: 'gridcraft', fetchBytes: github('none') }), null);
});

test('keep limits what is kept to the named paths, and a path that leaves /work is refused', async () => {
  const world = explorer({ replies: [JSON.stringify(GOOD)] });
  await world.run();
  const pack = world.log.find(entry => entry.argv?.[2]?.startsWith('set -e; cd /;')).argv[2];
  assert.ok(pack.includes("echo 'work/bin'") && !pack.includes("echo 'work'"), pack);
  assert.ok(pack.includes("find 'usr/local' -newer"), 'what setup wrote under kept_changes_under is still kept');
  // Without keep, all of /work is kept as before.
  const whole = explorer({ replies: [JSON.stringify({ ...GOOD, keep: undefined })] });
  await whole.run();
  assert.ok(whole.log.find(entry => entry.argv?.[2]?.startsWith('set -e; cd /;')).argv[2].includes("echo 'work';"));
  assert.deepEqual(planFrom({ argv: ['a'], keep: ['bin', '/work/dist/../lib', './tools', 'bin'] }).keep, ['/work/bin', '/work/lib', '/work/tools']);
  for (const escaping of ['../etc', '/etc/passwd', '/work/../usr', 'bin/../../x']) assert.throws(() => planFrom({ argv: ['a'], keep: [escaping] }), /must stay inside \/work/);
  assert.throws(() => planFrom({ argv: ['a'], keep: 'bin' }), /keep must be a list/);
  // A refused plan is one failed attempt the planner sees, not the end of the exploration.
  const retry = explorer({ replies: [JSON.stringify({ ...GOOD, keep: ['../etc'] }), JSON.stringify(GOOD)] });
  const result = await retry.run();
  assert.equal(result.tries, 2);
  assert.match(retry.prompts[1], /must stay inside \/work/);
});

test('outputs the plan names must exist and be non-empty, are kept as the files of whoever runs the tool, and the check keeps nothing', async () => {
  const wrong = { ...GOOD, argv: ['./bin/gridcraft-cli', 'run', '--sample', { input: 'sample' }, '--out', '/out/other.xlsx'] };
  const world = explorer({ replies: [JSON.stringify(wrong), JSON.stringify(GOOD)] });
  const result = await world.run();
  assert.equal(result.tries, 2, 'the right text with the named output missing is not a working round');
  assert.match(world.prompts[1], /these named outputs were not written or are empty: workbook: nothing written at \/out\/budget\.xlsx/);
  const clearing = world.log.filter(entry => entry.id === 'task_x:explore' && entry.argv?.[0] === 'rm');
  assert.deepEqual(clearing.at(-1).argv, ['rm', '-rf', '--', '/out/budget.xlsx'], 'an earlier round\'s file never satisfies a later round');
  assert.ok(world.log.some(entry => entry.id === 'task_x:explore' && entry.argv?.join(' ') === 'mkdir -p /out'));
  assert.deepEqual(result.descriptor.invoke.outputs, [{ name: 'workbook', path: '/out/budget.xlsx', keep_in: 'files', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]);
  assert.deepEqual(result.job_check, { passed: true, output: 'wrote budget.xlsx\n', files: { workbook: { bytes: 10 } } });
  // The offline check made the folder, ran with the network off and left its file in its own container only.
  const check = world.log.filter(entry => entry.id === 'task_x:check');
  assert.equal(check.find(entry => 'start' in entry).start, false);
  assert.equal(check.find(entry => entry.argv?.[0] === 'mkdir').argv.join(' '), 'mkdir -p /work /out');
  assert.deepEqual([...world.stored.keys()], [result.descriptor.bytes_fingerprint], 'only the kept tool is stored; the check\'s files are not');
  // A plan whose output never appears fails the exploration with that reason.
  const never = explorer({ replies: Array(3).fill(JSON.stringify(wrong)) });
  await assert.rejects(never.run(), /named outputs were not written/);
  // Output names and places are checked.
  assert.deepEqual(planFrom({ argv: ['a'], outputs: [{ name: 'pages', folder: '/out/pages' }, { name: 'one', path: 'one.txt' }] }).outputs, [{ name: 'pages', folder: '/out/pages' }, { name: 'one', path: '/out/one.txt' }]);
  assert.throws(() => planFrom({ argv: ['a'], outputs: [{ name: 'x', path: '/work/x' }] }), /must stay inside \/out/);
  assert.throws(() => planFrom({ argv: ['a'], outputs: [{ name: 'x', path: '/out/../etc/x' }] }), /must stay inside \/out/);
  assert.throws(() => planFrom({ argv: ['a'], outputs: [{ name: 'two words', path: '/out/x' }] }), /one-word name/);
  assert.throws(() => planFrom({ argv: ['a'], outputs: [{ name: 'x', path: '/out/x', folder: '/out/y' }] }), /exactly one of path/);
  assert.throws(() => planFrom({ argv: ['a'], outputs: [{ name: 'x', path: '/out/x' }, { name: 'x', path: '/out/y' }] }), /its own name/);
  assert.deepEqual(planFrom({ response: { setup: [], argv: ['b'] } }), { setup: [], argv: ['b'], why: '' });
});

test('a sample input that is one of the caller\'s files is staged in the container and becomes a file input', async () => {
  const hex = 'ab'.repeat(32);
  const identity = `1f:${hex}`;
  const opened = [];
  const files = { open: async id => { opened.push(id); return { name: '/docs/in.pdf', byte_length: 3, stream: () => new Blob(['pdf']).stream() }; } };
  const staged = `/inputs/${hex}/in.pdf`;
  const pdfcraft = (argv, box, options) => {
    if (argv[0] !== './bin/pdfcraft-cli' || !box.bin) return bad('not found', 127);
    assert.equal(argv[2], staged, 'the staged path stands in for the identity in argv');
    assert.equal(JSON.parse(options.stdin ? dec(options.stdin) : '{}').doc, staged, 'and in the JSON on standard input');
    assert.ok(box.files.get(staged), `${box.id} holds the staged file`);
    return ok(`page ${argv[4]} of in.pdf\n`);
  };
  const request = { repo_url: REQUEST.repo_url, job: 'Read the text of a PDF page', sample_input: { doc: identity, page: 1 }, expect_contains: 'of in.pdf' };
  const plan = { setup: [DOWNLOAD], argv: ['./bin/pdfcraft-cli', 'text', { input: 'doc' }, '--page', { input: 'page' }], keep: ['bin'] };
  const world = explorer({ program: pdfcraft, replies: [JSON.stringify(plan)] });
  const result = await world.run(request, SETTINGS, files);
  assert.ok(world.prompts[0].includes(`input "doc" is the file ${staged}`));
  assert.ok(world.prompts[0].includes(`"doc":"${staged}"`) && !world.prompts[0].includes(identity), 'the planner sees the path, not the identity');
  assert.deepEqual(world.log.filter(entry => entry.placed).map(entry => [entry.id, entry.placed]), [['task_x:explore', staged], ['task_x:check', staged]]);
  assert.deepEqual(opened, [identity]);
  assert.equal(result.job_check.passed, true, result.job_check.output);
  const { descriptor } = result;
  assert.deepEqual(descriptor.input_schema.properties.doc, { type: 'string', format: 'namespace-file', description: 'One of your files, given by its identity (1f: then 64 hex characters)' });
  assert.deepEqual(descriptor.input_schema.properties.page, { type: 'integer' });
  assert.deepEqual(descriptor.verify, [{ kind: 'sample-run', input: { doc: identity, page: 1 }, output_selector: '$.stdout', contains: 'of in.pdf' }]);
  assert.deepEqual(descriptor.invoke.argv, ['./bin/pdfcraft-cli', 'text', { fill: { from: 'input', field: 'doc' } }, '--page', { fill: { from: 'input', field: 'page' } }]);
  await assert.rejects(world.run(request), /one of your files, and this service has none/);
  await assert.rejects(explorer({ replies: [] }).run(request, SETTINGS, { open: async () => null }), /not in your files/);
});

// Pages GitHub really served for storytold/gridcraft on 2026-10-08 (trimmed to three assets), with the REST API refusing.
test('the release pages as GitHub really serves them give the linux x86_64 download', async () => {
  const page = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const asked = [];
  const fetchBytes = async url => {
    asked.push(url);
    if (url.startsWith('https://api.github.com/')) return new Response('rate limited', { status: 403 });
    if (url === 'https://github.com/storytold/gridcraft/releases/latest') return new Response(page('github-releases-latest-gridcraft-v0.3.0.html'));
    if (url === 'https://github.com/storytold/gridcraft/releases/expanded_assets/v0.3.0') return new Response(page('github-expanded-assets-gridcraft-v0.3.0.html'));
    return new Response('missing', { status: 404 });
  };
  const release = await latestRelease({ owner: 'storytold', repo: 'gridcraft', fetchBytes });
  assert.equal(release.tag, 'v0.3.0');
  assert.deepEqual(release.assets.map(asset => asset.name), ['gridcraft-0.3.0-linux-x86_64.tar.gz', 'gridcraft-0.3.0-macos-universal.dmg', 'SHA256SUMS.txt']);
  assert.equal(release.assets[0].url, 'https://github.com/storytold/gridcraft/releases/download/v0.3.0/gridcraft-0.3.0-linux-x86_64.tar.gz');
  assert.ok(release.assets[0].size > 1e6, 'the size shown on the page is read');
  assert.equal(asked.length, 3);
});

// The deployed container runs a command detached (begin, then outcome). `long` says which commands the container service
// drops when they are awaited as one exec call (the download, the setup, the sample run); `flaky` is called with each
// outcome() and may throw. exec still answers the quick commands.
const LONG = argv => argv[0] === 'node' || argv[0] === './bin/gridcraft-cli' || (argv[0] === 'sh' && /^(curl|fail|tar xzf)/.test(argv[2] ?? ''));
const disconnected = () => new Error('Container service disconnected.');
function detached({ flaky = () => {}, lostOnBegin = () => false } = {}) {
  const calls = { exec: 0, begin: 0, outcome: 0 };
  const wrap = program => {
    const inner = world(program);
    const slots = new Map();
    const sandboxFor = id => {
      const sandbox = inner.sandboxFor(id);
      return {
        ...sandbox,
        exec: async (argv, options) => { calls.exec += 1; if (LONG(argv)) throw disconnected(); return sandbox.exec(argv, options); },
        begin: async (argv, options) => {
          calls.begin += 1;
          if (lostOnBegin(argv, calls)) throw disconnected();
          slots.set(id, await sandbox.exec(argv, options));
          return { began: true };
        },
        outcome: async () => { calls.outcome += 1; flaky(calls); return slots.has(id) ? { state: 'done', ...slots.get(id) } : { state: 'none' }; },
        stop: async () => { slots.delete(id); return sandbox.stop(); },
      };
    };
    return { ...inner, sandboxFor };
  };
  return { calls, wrap };
}
function explorerWith(sandboxes, replies) {
  const prompts = [];
  const stored = new Map();
  const explore = repoExplorer({
    sandboxFor: sandboxes.sandboxFor,
    licenceClasses: async () => [{ id: 'licence:permissive', licences: ['Apache-2.0'], allowed_placements: ['placement:container'], store_bytes: true }],
    plan: async prompt => { prompts.push(prompt); return replies.shift(); },
    putBytes: async (fingerprint, bytes) => { stored.set(fingerprint, bytes); },
    fetchBytes: github('api'),
  });
  return { prompts, stored, run: () => explore({ invocation: { settings: SETTINGS, input: REQUEST }, task: { task_id: 'task_x' } }) };
}

test('long commands run detached when the sandbox can begin them, so a dropped exec call does not fail the exploration', async () => {
  const fake = detached();
  const sandboxes = fake.wrap(gridcraft);
  const world = explorerWith(sandboxes, [JSON.stringify(GOOD)]);
  const result = await world.run();
  assert.equal(result.job_check.passed, true);
  assert.equal(world.prompts.length, 1);
  assert.ok(fake.calls.begin >= 4, 'the download, unpack, listing, setup, sample run and the offline check were begun');
  assert.equal(sandboxes.log.filter(entry => entry.start === true).length, 1, 'no restart was needed');
});

test('an outcome answer that fails once with a retryable disconnect is asked again', async () => {
  let failed = false;
  const fake = detached({ flaky: calls => { if (!failed && calls.begin >= 3) { failed = true; throw Object.assign(disconnected(), { retryable: true }); } } });
  const world = explorerWith(fake.wrap(gridcraft), [JSON.stringify(GOOD)]);
  const result = await world.run();
  assert.ok(failed);
  assert.equal(result.job_check.passed, true);
  assert.equal(world.prompts.length, 1);
});

test('a container lost while a round begins starts the exploration over without spending a planner round', async () => {
  let lost = false;
  const fake = detached({ lostOnBegin: (argv, calls) => { if (!lost && argv[2] === DOWNLOAD) { lost = true; return true; } return false; } });
  const sandboxes = fake.wrap(gridcraft);
  const world = explorerWith(sandboxes, [JSON.stringify(GOOD)]);
  const result = await world.run();
  assert.ok(lost);
  assert.equal(result.job_check.passed, true);
  assert.equal(world.prompts.length, 1, 'the planner was asked once');
  assert.equal(sandboxes.log.filter(entry => entry.id === 'task_x:explore' && entry.start === true).length, 2, 'the explore container was started again');
});

test('a container that keeps being lost is given up on, with a retryable plain-language error', async () => {
  const fake = detached({ lostOnBegin: argv => argv[0] === 'node' });
  const world = explorerWith(fake.wrap(gridcraft), [JSON.stringify(GOOD)]);
  await assert.rejects(world.run(), error => error.retryable === true && /container was lost 3 times/.test(error.message));
});

test('a planner reply that wraps or overruns the plan still yields the last complete plan with argv', async () => {
  const first = { ...GOOD, why: 'first' };
  const second = { ...GOOD, why: 'second {with} "braces"' };
  const wrapped = `Here is my plan:\n\`\`\`json\n${JSON.stringify(first)}\n\`\`\`\nWait, wait, a revision:\n\`\`\`json\n${JSON.stringify(second)}\n\`\`\``;
  assert.equal(planFrom(wrapped).why, second.why, 'the revised object is used');
  const truncated = `${JSON.stringify(first).slice(0, 40)} ... ${JSON.stringify(second)}`;
  assert.equal(planFrom(truncated).why, second.why, 'a cut-off first object does not hide the complete second');
  assert.equal(planFrom(`${JSON.stringify(second)}\nand then {"note": 1} and {"argv": []}`).why, second.why, 'objects without argv are not plans');
  assert.throws(() => planFrom('["a", "b"]'), /no JSON object with argv/);
  assert.throws(() => planFrom(`${JSON.stringify(first).slice(0, 60)}`), /no JSON object with argv/);
});

test('a reply with no plan tells the next round plainly, and every prompt ends with the one-object instruction', async () => {
  const world = explorer({ replies: ['I would run the CLI, but let me think about it first.', JSON.stringify(GOOD)] });
  const result = await world.run();
  assert.equal(result.tries, 2);
  assert.match(world.prompts[1], /Your reply had no JSON object with argv; reply with only the JSON object/);
  for (const prompt of world.prompts) assert.match(prompt.split('\n').at(-1), /exactly one JSON object and nothing else/);
});
