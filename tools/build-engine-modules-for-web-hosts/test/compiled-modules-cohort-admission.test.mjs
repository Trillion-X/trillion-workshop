// Opposing-process checks use the actual builder and ordinary module consumers,
// with synthetic compiler executables so no Rust or WASM toolchain is run.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const crateNames = ['http-client', 'workflow-engine', 'screen-arrangement', 'composition-engine'];
// One build runs the compiler once for each crate row and once more, so a count follows the rows (never a fixed number).
const perBuild = crateNames.length + 1;
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const sandbox = realpathSync(tempFolder(join(tmpdir(), 'compiled-modules-cohort-')));
  const home = join(sandbox, 'app');
  mkdirSync(home);
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const names=${JSON.stringify(crateNames)}, args=process.argv.slice(2);
if(args[0]==='locate-project') console.log(join(dirname(dirname(args[args.indexOf('--manifest-path')+1])),'Cargo.toml'));
else if(args[0]==='metadata') { if(process.env.FAKE_METADATA_FAIL)process.exit(92);
 const file=join(process.cwd(),'../../../fixture-metadata.json'),metadata=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
 const local=names.map(name=>({id:name,name,source:null,metadata:metadata[name]??{},manifest_path:join(process.cwd(),name,'Cargo.toml')}));
 const packages=local;
 console.log(JSON.stringify({packages,resolve:{nodes:names.map(id=>({id,deps:[]}))}})); }
else { const crate=args[args.indexOf('-p')+1], target=args[args.indexOf('--target')+1];
 appendFileSync(process.env.FAKE_LOG,JSON.stringify({crate,target,generation:process.env.FAKE_GENERATION})+'\\n');
 if(process.env.FAKE_FAIL===crate) process.exit(17);
 if(process.env.FAKE_MUTATE_INPUT&&crate==='http-client')appendFileSync(process.env.FAKE_MUTATE_INPUT,'\\n');
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
    rmSync(sandbox, { recursive: true, force: true });
  }
  const declarePackage = (crate, metadata) => {
    const metadataPath = join(home, 'fixture-metadata.json');
    const declarations = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : {};
    declarations[crate] = metadata;
    writeFileSync(metadataPath, JSON.stringify(declarations));
    // Retain the declaration in crate source, as real Cargo metadata does. Malformed cases exercise its JSON contract.
    const files = metadata?.['compiled-module']?.['source-files'];
    const sourceText = Array.isArray(files) && files.every(file => typeof file === 'string')
      ? `source-files = ${JSON.stringify(files)}`
      : null;
    writeFileSync(join(home, CRATES, crate, 'Cargo.toml'), `[package]\nname = "${crate}"\nversion = "0.1.0"\n` +
      (sourceText ? `\n[package.metadata.compiled-module]\n${sourceText}\n` : `\n# malformed fixture metadata: ${JSON.stringify(metadata)}\n`));
  };
  const declare = metadata => declarePackage('http-client', metadata);
  return { home, sandbox, built, env, run, log, done, declare, declarePackage };
}

async function waitFor(check, message) {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error(message);
    await delay(10);
  }
}

test('ordinary prepare holds one published generation while a producer waits to replace it', async () => {
  const f = fixture();
  try {
    const initial = f.run(undefined, { FAKE_GENERATION: 'A' });
    const initialResult = await initial.ended;
    assert.equal(initialResult.code, 0, initialResult.output);
    writeFileSync(f.env.FAKE_LOG, '');
    const gate = join(f.home, 'reader-at-first-folder');
    const release = join(f.home, 'release-reader');
    const preload = join(f.home, 'pause-reader.mjs');
    writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const cp=fs.cpSync;let stopped=false;fs.cpSync=(src,dst,options)=>{const answer=cp(src,dst,options);if(!stopped&&String(src).endsWith('/held-values')){stopped=true;fs.writeFileSync(${JSON.stringify(gate)},'ready');const until=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>until)process.exit(93);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}}return answer};syncBuiltinESMExports();`);
    const reader = f.run(['--input-type=module', '-e', `import{prepareCompiledModules,COMPILED_MODULES,PAGE_COMPILED_MODULES}from'./${BUILD}/compiled-modules.mjs';await prepareCompiledModules({modules:[...COMPILED_MODULES,...PAGE_COMPILED_MODULES]});`], { NODE_OPTIONS: `--import=${preload}`, FAKE_GENERATION: 'reader' });
    await waitFor(() => existsSync(gate), 'the ordinary prepared-module consumer did not reach its first folder copy');

    writeFileSync(join(f.home, CRATES, 'workflow-engine/src/lib.rs'), '// source changed after reader admission\n');
    const producer = f.run(undefined, { FAKE_GENERATION: 'B' });
    await delay(300);
    assert.equal(f.log().length, 0, 'the producer must wait before invoking the compiler while the reader holds its generation');
    assert.equal(producer.child.exitCode, null, 'the producer remains admitted behind the reader');

    writeFileSync(release, 'go');
    const [readResult, buildResult] = await Promise.all([reader.ended, producer.ended]);
    assert.equal(readResult.code, 0, readResult.output);
    assert.equal(buildResult.code, 0, buildResult.output);
    for (const file of ['held-values/http_client.js', 'workflow-engine/workflow_engine.js', 'screen-arrangement/screen_arrangement.js']) {
      assert.match(readFileSync(join(f.home, 'dist', file), 'utf8'), /"A"/, `${file} must come from the same generation the reader admitted`);
    }
    assert.match(readFileSync(join(f.built, 'workflow-engine/workflow_engine.js'), 'utf8'), /"B"/, 'the waiting producer publishes the new generation after the reader finishes');
  } finally { await f.done(); }
});

test('ordinary builder recovers the old cohort after an interrupted publication move', async () => {
  const f = fixture();
  try {
    const initial = f.run(undefined, { FAKE_GENERATION: 'A' });
    const initialResult = await initial.ended;
    assert.equal(initialResult.code, 0, initialResult.output);
    const oldFingerprint = readFileSync(join(f.built, 'fingerprint.json'), 'utf8');
    const oldBytes = readFileSync(join(f.built, 'workflow-engine/workflow_engine.js'), 'utf8');
    writeFileSync(join(f.home, CRATES, 'workflow-engine/src/lib.rs'), '// changed before interrupted build\n');
    const preload = join(f.home, 'exit-between-renames.mjs');
    writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;fs.renameSync=(from,to)=>{const result=rename(from,to);if(String(from).endsWith('/built-stored-bytes')&&String(to).endsWith('/previous'))process.exit(91);return result};syncBuiltinESMExports();`);
    const crashed = f.run(undefined, { NODE_OPTIONS: `--import=${preload}`, FAKE_GENERATION: 'B' });
    const crashResult = await crashed.ended;
    assert.equal(crashResult.code, 91, crashResult.output);
    assert.equal(existsSync(f.built), false, 'fixture reaches the real rename gap with the original cohort retained in recovery staging');
    assert.ok(readdirSync(join(f.home, TOOL)).some(name => name.startsWith('.compiled-modules-')));

    const retry = f.run(undefined, { FAKE_GENERATION: 'C', FAKE_FAIL: 'http-client' });
    const retryResult = await retry.ended;
    assert.notEqual(retryResult.code, 0, 'the synthetic compiler fails after the normal builder acquires ownership');
    assert.equal(readFileSync(join(f.built, 'fingerprint.json'), 'utf8'), oldFingerprint, 'recovery restores the entire original fingerprint before the failed retry');
    assert.equal(readFileSync(join(f.built, 'workflow-engine/workflow_engine.js'), 'utf8'), oldBytes, 'recovery preserves original module bytes');
    assert.equal(readdirSync(join(f.home, TOOL)).some(name => name.startsWith('.compiled-modules-')), false, 'completed recovery removes its private staging area');
  } finally { await f.done(); }
});

test('declared package DATA participates in ordinary compiled-module freshness without Cargo at admission', async () => {
  const f = fixture();
  try {
    f.declare({ 'compiled-module': { 'source-files': ['../../../../package.json'] } });
    const first = await f.run().ended; assert.equal(first.code, 0, first.output);
    const original = JSON.parse(readFileSync(join(f.built, 'fingerprint.json'), 'utf8'));
    assert.deepEqual(original.source_files, ['package.json']);
    const read = `import assert from 'node:assert/strict';import{committedModulesCurrent,withCommittedModules}from'./${BUILD}/compiled-modules.mjs';assert.equal(await committedModulesCurrent(),true);await withCommittedModules(metadata=>{assert.deepEqual(metadata.source_files,['package.json']);assert.ok(Object.isFrozen(metadata.source_files));});`;
    const admitted = await f.run(['--input-type=module', '-e', read], { WORKERS_CI: '1', FAKE_METADATA_FAIL: '1' }).ended;
    assert.equal(admitted.code, 0, admitted.output);
    writeFileSync(join(f.home, 'package.json'), '{"type":"module","packageData":"changed"}\n');
    const stale = await f.run(['--input-type=module', '-e', `import assert from 'node:assert/strict';import{committedModulesCurrent}from'./${BUILD}/compiled-modules.mjs';assert.equal(await committedModulesCurrent(),false);`], { FAKE_METADATA_FAIL: '1' }).ended;
    assert.equal(stale.code, 0, stale.output);
    const rebuilt = await f.run(undefined, { FAKE_GENERATION: 'B' }).ended; assert.equal(rebuilt.code, 0, rebuilt.output);
    assert.equal(f.log().length, 2 * perBuild, 'only changing declared package DATA causes the ordinary owner to compile again');
    assert.notEqual(JSON.parse(readFileSync(join(f.built, 'fingerprint.json'), 'utf8')).fingerprint, original.fingerprint);
    assert.match(readFileSync(join(f.built, 'workflow-engine/workflow_engine.js'), 'utf8'), /"B"/);
  } finally { await f.done(); }
});

test('two dependency-closure crates may declare the same app DATA without duplicate receipt entries', async () => {
  const f = fixture();
  try {
    const declaration = { 'compiled-module': { 'source-files': ['../../../../package.json'] } };
    f.declarePackage('workflow-engine', declaration);
    f.declarePackage('http-client', declaration);
    const first = await f.run().ended; assert.equal(first.code, 0, first.output);
    const receipt = JSON.parse(readFileSync(join(f.built, 'fingerprint.json'), 'utf8'));
    assert.deepEqual(receipt.source_files, ['package.json']);
    const admitted = await f.run(['--input-type=module', '-e', `import assert from 'node:assert/strict';import{committedModulesCurrent}from'./${BUILD}/compiled-modules.mjs';assert.equal(await committedModulesCurrent(),true);`], { FAKE_METADATA_FAIL: '1' }).ended;
    assert.equal(admitted.code, 0, admitted.output);
  } finally { await f.done(); }
});

test('empty source lists preserve the existing crate, workspace manifest, and lock fingerprint', async () => {
  const f = fixture();
  try {
    const first = await f.run().ended; assert.equal(first.code, 0, first.output);
    const original = JSON.parse(readFileSync(join(f.built, 'fingerprint.json'), 'utf8'));
    console.info('legacy fixture source fingerprint', original.fingerprint);
    const script = `import assert from 'node:assert/strict';import{crateSourceFingerprint}from'./${BUILD}/compiled-modules.mjs';const dirs=${JSON.stringify(original.crate_dirs)};assert.equal(await crateSourceFingerprint(dirs),${JSON.stringify(original.fingerprint)});assert.equal(await crateSourceFingerprint(dirs,[]),${JSON.stringify(original.fingerprint)});`;
    const checked = await f.run(['--input-type=module', '-e', script]).ended; assert.equal(checked.code, 0, checked.output);
  } finally { await f.done(); }
});

for (const [name, metadata, prepare] of [
  ['a nonobject compiled-module declaration', {'compiled-module': 'wrong'}],
  ['a misspelled declaration field', {'compiled-module': {'source_files': ['../../../../package.json']}}],
  ['a scalar source list', {'compiled-module': {'source-files': '../../../../package.json'}}],
  ['a nonstring source path', {'compiled-module': {'source-files': [42]}}],
  ['an absolute source path', {'compiled-module': {'source-files': ['/package.json']}}],
  ['an outside-app source path', {'compiled-module': {'source-files': ['../../../../../package.json']}}],
  ['a missing source file', {'compiled-module': {'source-files': ['../../../../missing.json']}}],
  ['a directory source', {'compiled-module': {'source-files': ['../../../../tools']}}],
  ['a lexical path alias', {'compiled-module': {'source-files': ['../../../../tools/../package.json']}}],
  ['a case alias', {'compiled-module': {'source-files': ['../../../../Package.json']}}],
  ['a symbolic file alias', {'compiled-module': {'source-files': ['../../../../alias.json']}}, f=>symlinkSync('package.json',join(f.home,'alias.json'))],
  ['a symbolic directory alias', {'compiled-module': {'source-files': ['../../../../alias/compiled-modules.mjs']}}, f=>symlinkSync(BUILD,join(f.home,'alias'),'dir')],
  ['a hard-link alias', {'compiled-module': {'source-files': ['../../../../alias.json']}}, f=>linkSync(join(f.home,'package.json'),join(f.home,'alias.json'))],
]) test(`ordinary builder refuses ${name} before invoking a compiler`, async () => {
  const f = fixture();
  try {
    prepare?.(f);f.declare(metadata);
    const result = await f.run().ended;
    assert.notEqual(result.code, 0, result.output);
    assert.equal(f.log().length, 0, 'an invalid declaration cannot get compiler or publication work');
    assert.equal(existsSync(f.built), false);
  } finally { await f.done(); }
});

test('ordinary builder restores omitted or undeclared app DATA receipt entries instead of reusing a waived stamp', async () => {
  const f = fixture();
  try {
    f.declare({'compiled-module': {'source-files': ['../../../../package.json']}});
    const first = await f.run().ended; assert.equal(first.code, 0, first.output);
    const old = readFileSync(join(f.built,'fingerprint.json'),'utf8');
    const tamper = `import{readFileSync,writeFileSync}from'node:fs';import{BUILT_CRATES_FOLDER}from'./${BUILD}/compiled-modules.mjs';const path=BUILT_CRATES_FOLDER+'/fingerprint.json',value=JSON.parse(readFileSync(path));value.source_files=[];writeFileSync(path,JSON.stringify(value));`;
    const changed = await f.run(['--input-type=module','-e',tamper]).ended;assert.equal(changed.code,0,changed.output);
    const rebuild = await f.run(undefined,{FAKE_GENERATION:'B'}).ended;assert.equal(rebuild.code,0,rebuild.output);
    assert.equal(f.log().length, 2 * perBuild,'declared app DATA cannot be waived by a retained empty input list');
    assert.deepEqual(JSON.parse(readFileSync(join(f.built,'fingerprint.json'),'utf8')).source_files,['package.json']);
    assert.equal(readFileSync(join(f.built,'fingerprint.json'),'utf8'),old,'restoring the same declared inputs restores the same source identity');
    assert.match(readFileSync(join(f.built,'workflow-engine/workflow_engine.js'),'utf8'),/"B"/);
    writeFileSync(join(f.home,'extra.json'),'{}\n');
    const extra = tamper.replace('value.source_files=[]','value.source_files=["package.json","extra.json"]');
    const extraStamp = await f.run(['--input-type=module','-e',extra]).ended;assert.equal(extraStamp.code,0,extraStamp.output);
    const declared = await f.run(undefined,{FAKE_GENERATION:'C'}).ended;assert.equal(declared.code,0,declared.output);
    assert.equal(f.log().length, 3 * perBuild,'a retained but undeclared input cannot replace the declared app DATA list');
    assert.deepEqual(JSON.parse(readFileSync(join(f.built,'fingerprint.json'),'utf8')).source_files,['package.json']);
    assert.match(readFileSync(join(f.built,'workflow-engine/workflow_engine.js'),'utf8'),/"C"/);
  } finally { await f.done(); }
});

test('a declared package source changed during compilation refuses without publishing any new cohort', async () => {
  const f = fixture();
  try {
    f.declare({'compiled-module': {'source-files': ['../../../../package.json']}});
    const first = await f.run().ended;assert.equal(first.code,0,first.output);
    const oldFingerprint=readFileSync(join(f.built,'fingerprint.json'),'utf8'),oldBytes=readFileSync(join(f.built,'workflow-engine/workflow_engine.js'),'utf8');
    // Force the ordinary builder to start; its synthetic first compiler then changes only the declared DATA bytes again.
    writeFileSync(join(f.home,'package.json'),'{"type":"module","data":"before-build"}\n');
    const changed=await f.run(undefined,{FAKE_GENERATION:'B',FAKE_MUTATE_INPUT:join(f.home,'package.json')}).ended;
    assert.notEqual(changed.code,0);assert.match(changed.output,/sources changed during compilation/i);
    assert.equal(readFileSync(join(f.built,'fingerprint.json'),'utf8'),oldFingerprint);
    assert.equal(readFileSync(join(f.built,'workflow-engine/workflow_engine.js'),'utf8'),oldBytes);
    assert.equal(readdirSync(join(f.home,TOOL)).some(name=>name.startsWith('.compiled-modules-')),false);
  } finally { await f.done(); }
});

test('changed compiler path configuration invalidates and rebuilds the ordinary cohort', async () => {
  const f = fixture();
  try {
    const first = await f.run().ended;
    assert.equal(first.code, 0, first.output);
    const previous = JSON.parse(readFileSync(join(f.built, 'fingerprint.json'), 'utf8'));
    const config = join(f.home, BUILD, 'shared-cargo-target.mjs');
    const before = readFileSync(config, 'utf8');
    const after = before.replace("'/checkouts'", "'/checkout-sources'");
    assert.notEqual(after, before, 'the fixture changes an actual compiler path option');
    writeFileSync(config, after);
    const stale = await f.run(['--input-type=module', '-e', `import assert from 'node:assert/strict';import{committedModulesCurrent}from'./${BUILD}/compiled-modules.mjs';assert.equal(await committedModulesCurrent(),false);`], { FAKE_METADATA_FAIL: '1' }).ended;
    assert.equal(stale.code, 0, stale.output);
    const rebuilt = await f.run(undefined, { FAKE_GENERATION: 'B' }).ended;
    assert.equal(rebuilt.code, 0, rebuilt.output);
    assert.notEqual(JSON.parse(readFileSync(join(f.built, 'fingerprint.json'), 'utf8')).fingerprint, previous.fingerprint);
    assert.equal(f.log().length, 2 * perBuild, 'the normal owner recompiles after only compiler configuration changed');
    assert.match(readFileSync(join(f.built, 'workflow-engine/workflow_engine.js'), 'utf8'), /"B"/);
  } finally { await f.done(); }
});

