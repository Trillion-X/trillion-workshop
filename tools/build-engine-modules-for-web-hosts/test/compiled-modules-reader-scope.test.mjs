// Opposing-process checks use the actual builder and ordinary module consumers,
// with synthetic compiler executables so no Rust or WASM toolchain is run.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The sandbox is a made-up Workshop: this tool's build scripts and the cache-folder rule they read, a made-up tool with
// made-up crates, and the built modules.
const source = fileURLToPath(new URL('..', import.meta.url));
const cacheRule = fileURLToPath(new URL('../../process-session/do-work/computer-cache-folder.mjs', import.meta.url));
const TOOL = 'tools/build-engine-modules-for-web-hosts';
const CRATES = 'tools/made-up-crates/crates';
const BUILD = `${TOOL}/build`;
const crateNames = ['http-client', 'workflow-engine', 'screen-arrangement', 'composition-engine', 'workflow-component'];
// One build runs the compiler once for each crate row and once more, so a count follows the rows (never a fixed number).
const perBuild = crateNames.length + 1;
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const home = tempFolder(join(tmpdir(), 'compiled-modules-cohort-'));
  const built = join(home, TOOL, 'built-stored-bytes');
  mkdirSync(join(home, BUILD), { recursive: true });
  for (const name of ['shared-cargo-target.mjs', 'build-crate-for-a-web-host.mjs', 'compiled-modules.mjs', 'build-compiled-modules.mjs']) {
    cpSync(join(source, 'build', name), join(home, BUILD, name));
  }
  mkdirSync(join(home, 'tools/process-session/do-work'), { recursive: true });
  cpSync(cacheRule, join(home, 'tools/process-session/do-work/computer-cache-folder.mjs'));
  writeFileSync(join(home, 'package.json'), '{"type":"module"}\n');
  const nodeModules = dirname(dirname(dirname(fileURLToPath(import.meta.resolve('@noble/hashes/blake3.js')))));
  symlinkSync(nodeModules, join(home, 'node_modules'), 'dir');
  for (const name of crateNames) {
    mkdirSync(join(home, CRATES, name, 'src'), { recursive: true });
    writeFileSync(join(home, CRATES, name, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "0.1.0"\n`);
    writeFileSync(join(home, CRATES, name, 'src/lib.rs'), `// source ${name}\n`);
  }
  writeFileSync(join(home, CRATES, 'Cargo.toml'), '[workspace]\nmembers = ["*"]\n');
  writeFileSync(join(home, CRATES, 'Cargo.lock'), '[[package]]\nname = "wasm-bindgen"\nversion = "0.2.120"\n');
  for (const [part, file] of [
    ['tools/browse-and-upload-my-files/built-stored-bytes/content-chunks', 'chunks.bin'],
    ['tools/formula-engine/built-stored-bytes/formula-engine', 'evaluate.bin'],
  ]) {
    mkdirSync(join(home, part), { recursive: true });
    writeFileSync(join(home, part, file), 'owner bytes');
  }

  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'cargo'), `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const names=${JSON.stringify(crateNames)}, args=process.argv.slice(2);
if(args[0]==='metadata') console.log(JSON.stringify({packages:names.map(name=>({id:name,name,source:null,manifest_path:join(process.cwd(),name,'Cargo.toml')})),resolve:{nodes:names.map(id=>({id,deps:[]}))}}));
else { const crate=args[args.indexOf('-p')+1], target=args[args.indexOf('--target')+1];
 appendFileSync(process.env.FAKE_LOG,JSON.stringify({crate,target,generation:process.env.FAKE_GENERATION})+'\\n');
 if(process.env.FAKE_FAIL===crate) process.exit(17);
 const folder=join(process.env.CARGO_TARGET_DIR,target,'release');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,crate.replaceAll('-','_')+'.wasm'),Buffer.from(${JSON.stringify([...wasm])})); }
` , { mode: 0o755 });
  writeFileSync(join(bin, 'wasm-bindgen'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';import { join } from 'node:path';
const args=process.argv.slice(2);if(args[0]==='--version') console.log('wasm-bindgen 0.2.120');else { const folder=args[args.indexOf('--out-dir')+1],name=args[args.indexOf('--out-name')+1];mkdirSync(folder,{recursive:true});
writeFileSync(join(folder,name+'.js'),'export function initSync() { return '+JSON.stringify(process.env.FAKE_GENERATION)+'; }\\n');writeFileSync(join(folder,name+'_bg.wasm'),Buffer.from(${JSON.stringify([...wasm])})); }
`, { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TRILLION_CARGO_TARGET_DIR: join(home, 'cache/cargo-target'),
    FAKE_LOG: join(home, 'compiler.log'),
  };
  const children = [];
  function run(args = [`${BUILD}/build-compiled-modules.mjs`], extra = {}) {
    const child = spawn(process.execPath, args, { cwd: home, env: { ...env, FAKE_GENERATION: 'A', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const ended = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, output })));
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    ended.finally(() => clearTimeout(timer));
    children.push({ child, ended });
    return { child, ended };
  }
  const log = () => existsSync(env.FAKE_LOG) ? readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  async function done() {
    for (const { child, ended } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await ended;
    }
    rmSync(home, { recursive: true, force: true });
  }
  return { home, built, env, run, log, done };
}

async function waitFor(check, message) {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error(message);
    await delay(10);
  }
}

test('nested preparation reuses admitted metadata without cache pruning or source timestamp writes', async () => {
  const f = fixture();
  try {
    const initial = await f.run().ended; assert.equal(initial.code, 0, initial.output);
    writeFileSync(join(f.home, CRATES, 'not-a-workspace-source.txt'), 'cache identity changed only');
    const script = `import assert from 'node:assert/strict';import{readFileSync,statSync,utimesSync}from'node:fs';import{withCommittedModules,prepareCompiledModules}from'./${BUILD}/compiled-modules.mjs';
const source='${CRATES}/workflow-engine/src/lib.rs';const old=new Date('2026-01-01T00:00:00.000Z');utimesSync(source,old,old);
const before=readFileSync(process.env.TRILLION_CARGO_TARGET_DIR+'/workspace-sources.json','utf8');
await withCommittedModules(async outer=>{assert.ok(Object.isFrozen(outer));assert.ok(Object.isFrozen(outer.crate_dirs));const inner=await withCommittedModules(value=>value);assert.strictEqual(inner,outer);await prepareCompiledModules();});
assert.equal(statSync(source).mtimeMs,old.getTime());assert.equal(readFileSync(process.env.TRILLION_CARGO_TARGET_DIR+'/workspace-sources.json','utf8'),before);`;
    const result = await f.run(['--input-type=module', '-e', script], { WORKERS_CI: '1' }).ended;
    assert.equal(result.code, 0, result.output);
    assert.match(readFileSync(join(f.home, 'dist/workflow-engine/workflow_engine.js'), 'utf8'), /"A"/);
    assert.equal(f.log().length, perBuild, 'the nested reader never invokes a compiler');
  } finally { await f.done(); }
});

test('nested reader lifetime is retained and expired inherited callbacks acquire fresh admission', async () => {
  const f = fixture();
  try {
    const initial = await f.run().ended; assert.equal(initial.code, 0, initial.output);
    const script = `import assert from 'node:assert/strict';import{withCommittedModules}from'./${BUILD}/compiled-modules.mjs';
let release,started,child;const held=new Promise(r=>release=r),ready=new Promise(r=>started=r);let settled=false;const events=[];
const outer=withCommittedModules(async metadata=>{child=withCommittedModules(async nested=>{assert.strictEqual(nested,metadata);events.push('child-start');started();await held;events.push('child-end');});await ready;events.push('outer-return');return metadata.fingerprint;});
outer.then(()=>{settled=true});await ready;await new Promise(r=>setTimeout(r,20));assert.equal(settled,false);release();await outer;await child;assert.deepEqual(events,['child-start','outer-return','child-end']);
let trigger,late;const next=new Promise(r=>trigger=r);await withCommittedModules(metadata=>{late=next.then(()=>withCommittedModules(fresh=>{assert.notStrictEqual(fresh,metadata);assert.equal(fresh.fingerprint,metadata.fingerprint);}));});trigger();await late;
const separate=[];await Promise.all([withCommittedModules(async one=>{separate.push(one);await new Promise(r=>setTimeout(r,20));}),withCommittedModules(two=>separate.push(two))]);assert.equal(separate.length,2);assert.notStrictEqual(separate[0],separate[1]);`;
    const result = await f.run(['--input-type=module', '-e', script], { WORKERS_CI: '1' }).ended;
    assert.equal(result.code, 0, result.output);
    assert.equal(f.log().length, perBuild);
  } finally { await f.done(); }
});

test('a refused reader releases the same owner and later reader admission still succeeds', async () => {
  const f = fixture();
  try {
    const initial = await f.run().ended; assert.equal(initial.code, 0, initial.output);
    const script = `import assert from 'node:assert/strict';import{existsSync}from'node:fs';import{withCommittedModules}from'./${BUILD}/compiled-modules.mjs';
await assert.rejects(withCommittedModules(()=>{throw new Error('synthetic reader refusal')}),/synthetic reader refusal/);assert.equal(existsSync(process.env.TRILLION_CARGO_TARGET_DIR+'.lock'),false);const fingerprint=await withCommittedModules(metadata=>metadata.fingerprint);assert.equal(typeof fingerprint,'string');assert.equal(existsSync(process.env.TRILLION_CARGO_TARGET_DIR+'.lock'),false);`;
    const result = await f.run(['--input-type=module', '-e', script], { WORKERS_CI: '1' }).ended;
    assert.equal(result.code, 0, result.output);
    assert.equal(f.log().length, perBuild);
  } finally { await f.done(); }
});

test('a cargo build holding the shared target does not delay readers of the current generation', async () => {
  const f = fixture();
  try {
    const initial = await f.run().ended; assert.equal(initial.code, 0, initial.output);
    // Another build owns the shared target for as long as this test runs: a live process's id in its lock.
    const holder = f.run(['-e', 'setTimeout(() => {}, 60000)']);
    const lock = join(f.home, 'cache/cargo-target.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(holder.child.pid));
    const script = `import assert from 'node:assert/strict';import{withCommittedModules,withStagedModules,prepareCompiledModules}from'./${BUILD}/compiled-modules.mjs';
assert.equal(typeof await withCommittedModules(metadata=>metadata.fingerprint),'string');await withStagedModules(()=>{});await prepareCompiledModules();`;
    const started = Date.now();
    const result = await f.run(['--input-type=module', '-e', script], { WORKERS_CI: '1' }).ended;
    assert.equal(result.code, 0, result.output);
    assert.ok(Date.now() - started < 20000, `readers waited ${Date.now() - started} ms for the cargo target`);
    assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(holder.child.pid), 'the build\'s lock is left as it was');
    assert.ok(existsSync(join(f.home, 'dist/workflow-engine/workflow_engine.js')));
    assert.equal(f.log().length, perBuild, 'readers never invoke a compiler');
  } finally { await f.done(); }
});

test('staging for a release copies the committed generation and its restartable glue without a fingerprint check or a compiler', async () => {
  const f = fixture();
  try {
    const initial = await f.run().ended; assert.equal(initial.code, 0, initial.output);
    // A crate source that no longer matches the committed modules: a release has neither cargo nor the engine's crates to say so.
    writeFileSync(join(f.home, CRATES, 'workflow-engine/src/lib.rs'), '// changed after the build\n');
    const script = `import{stageCommittedModules}from'./${BUILD}/compiled-modules.mjs';await stageCommittedModules();`;
    const result = await f.run(['--input-type=module', '-e', script], { WORKERS_CI: '1', FAKE_METADATA_FAIL: '1' }).ended;
    assert.equal(result.code, 0, result.output);
    assert.match(readFileSync(join(f.home, 'dist/workflow-engine/workflow_engine.js'), 'utf8'), /"A"/);
    assert.ok(existsSync(join(f.home, 'dist/workflow-engine/workflow_engine.fresh.js')));
    assert.equal(readFileSync(join(f.home, 'dist/formula-engine/evaluate.bin'), 'utf8'), 'owner bytes');
    assert.equal(f.log().length, perBuild, 'staging never invokes a compiler');
  } finally { await f.done(); }
});
