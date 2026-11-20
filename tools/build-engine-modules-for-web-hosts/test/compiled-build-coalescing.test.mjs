// Real owner scripts with synthetic compiler processes: no Rust/WASM compilation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The sandbox is a made-up Workshop: this tool's build scripts and the cache-folder rule they read, a made-up tool with
// made-up crates, and the built modules.
const source = process.env.BUILD_TEST_SOURCE ?? fileURLToPath(new URL('..', import.meta.url));
const cacheRule = fileURLToPath(new URL('../../process-session/do-work/computer-cache-folder.mjs', import.meta.url));
const TOOL = 'tools/build-engine-modules-for-web-hosts';
const CRATES = 'tools/made-up-crates/crates';
const BUILD = `${TOOL}/build`;
const names = ['http-client', 'workflow-engine', 'screen-arrangement', 'composition-engine'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const files = {
  'held-values': ['http_client.js', 'http_client_bg.wasm'],
  'workflow-engine': ['workflow_engine.js', 'workflow_engine_bg.wasm'],
  'screen-arrangement': ['screen_arrangement.js', 'screen_arrangement_bg.wasm'],
  'composition-engine': ['composition_engine.wasm', 'composition_engine.js', 'composition_engine_bg.wasm'],
};

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'compiled-build-owner-'));
  const built = join(home, TOOL, 'built-stored-bytes');
  mkdirSync(join(home, BUILD), { recursive: true });
  for (const name of ['shared-cargo-target.mjs', 'build-crate-for-a-web-host.mjs', 'compiled-modules.mjs', 'build-compiled-modules.mjs']) {
    cpSync(join(source, 'build', name), join(home, BUILD, name));
  }
  mkdirSync(join(home, 'tools/process-session/do-work'), { recursive: true });
  cpSync(cacheRule, join(home, 'tools/process-session/do-work/computer-cache-folder.mjs'));
  writeFileSync(join(home, 'package.json'), '{"type":"module"}');
  const nodeModules = dirname(dirname(dirname(fileURLToPath(import.meta.resolve('@noble/hashes/blake3.js')))));
  symlinkSync(nodeModules, join(home, 'node_modules'), 'dir');
  for (const name of names) {
    mkdirSync(join(home, CRATES, name, 'src'), { recursive: true });
    writeFileSync(join(home, CRATES, name, 'Cargo.toml'), `[package]\nname="${name}"\nversion="0.1.0"\n`);
    writeFileSync(join(home, CRATES, name, 'src/lib.rs'), '// original source\n');
  }
  writeFileSync(join(home, CRATES, 'Cargo.toml'), '[workspace]\nmembers = ["*"]\n');
  writeFileSync(join(home, CRATES, 'Cargo.lock'), '[[package]]\nname = "wasm-bindgen"\nversion = "0.2.120"\n');
  for (const [folder, entries] of Object.entries(files)) {
    mkdirSync(join(built, folder), { recursive: true });
    for (const file of entries) writeFileSync(join(built, folder, file), `old:${folder}/${file}`);
  }
  mkdirSync(join(built, 'unmanaged'), { recursive: true });
  writeFileSync(join(built, 'unmanaged/keep.txt'), 'unmanaged-original');
  const keptTime = new Date('2026-01-01T00:00:00.000Z');
  utimesSync(join(built, 'unmanaged/keep.txt'), keptTime, keptTime);
  symlinkSync('unmanaged/keep.txt', join(built, 'unmanaged-link'));
  const copiedPart = join(home, 'tools/formula-engine/built-stored-bytes/formula-engine');
  mkdirSync(copiedPart, { recursive: true });
  writeFileSync(join(copiedPart, 'keep.bin'), 'part-owner-original');
  writeFileSync(join(built, 'fingerprint.json'), JSON.stringify({ crate_dirs: names, fingerprint: 'stale' }));
  const bin = join(home, 'bin'); mkdirSync(bin);
  const cargo = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args=process.argv.slice(2), names=${JSON.stringify(names)};
if(args[0]==='metadata') {
 console.log(JSON.stringify({packages:names.map(name=>({id:name,name,source:null,manifest_path:join(process.cwd(),name,'Cargo.toml')})),resolve:{nodes:names.map(id=>({id,deps:[]}))}}));
} else {
 const crate=args[args.indexOf('-p')+1], target=args[args.indexOf('--target')+1];
 appendFileSync(process.env.FAKE_LOG,JSON.stringify({crate,target,pid:process.pid})+'\\n');
 if(process.env.FAKE_WAIT && !existsSync(process.env.FAKE_RELEASE)) while(!existsSync(process.env.FAKE_RELEASE)) await new Promise(r=>setTimeout(r,10));
 if(process.env.FAKE_FAIL===crate) process.exit(17);
 if(process.env.FAKE_DRIFT===crate) writeFileSync(join(process.cwd(),crate,'src/lib.rs'),'// changed during build\\n');
 const folder=join(process.env.CARGO_TARGET_DIR,target,'release');mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,crate.replaceAll('-','_')+'.wasm'),Buffer.from([0,97,115,109,1,0,0,0]));
}
`;
  const bindgen = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';import { join } from 'node:path';
const args=process.argv.slice(2);if(args[0]==='--version') console.log('wasm-bindgen 0.2.120');
else { const folder=args[args.indexOf('--out-dir')+1],name=args[args.indexOf('--out-name')+1];mkdirSync(folder,{recursive:true});
writeFileSync(join(folder,name+'.js'),'export function initSync() {}\\n');writeFileSync(join(folder,name+'_bg.wasm'),Buffer.from([0,97,115,109,1,0,0,0])); }
`;
  writeFileSync(join(bin, 'cargo'), cargo, { mode: 0o755 });
  writeFileSync(join(bin, 'wasm-bindgen'), bindgen, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRILLION_CARGO_TARGET_DIR: join(home, 'cache/target'), FAKE_LOG: join(home, 'builds.log'), FAKE_RELEASE: join(home, 'release') };
  const children = [];
  function run(args = [`${BUILD}/build-compiled-modules.mjs`], extra = {}) {
    const child = spawn(process.execPath, args, { cwd: home, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const ended = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, output })));
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    ended.finally(() => clearTimeout(timer));
    children.push({ child, ended });
    return ended;
  }
  async function done() {
    writeFileSync(join(home, 'release'), 'go');
    await Promise.all(children.map(async ({ child, ended }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await ended;
    }));
    rmSync(home, { recursive: true, force: true });
  }
  return { home, built, env, run, done,
    builds: () => existsSync(env.FAKE_LOG) ? readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

async function waitFor(check) {
  const until = Date.now() + 4000;
  while (!check()) { if (Date.now() > until) throw new Error('fixture did not reach its controlled boundary'); await pause(10); }
}

test('compiler failure leaves the complete published generation and fingerprint unchanged', async () => {
  const f = setup();
  try {
    const before = readFileSync(join(f.built, 'fingerprint.json'), 'utf8');
    const result = await f.run(undefined, { FAKE_FAIL: 'workflow-engine' });
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(join(f.built, 'fingerprint.json'), 'utf8'), before);
    for (const [folder, entries] of Object.entries(files)) for (const file of entries) assert.equal(readFileSync(join(f.built, folder, file), 'utf8'), `old:${folder}/${file}`);
    assert.equal(existsSync(`${f.env.TRILLION_CARGO_TARGET_DIR}.lock`), false);
  } finally { await f.done(); }
});

test('same-process calls await cooperatively and held builders cannot escape their scope', async () => {
  const f = setup();
  try {
    const script = `import{withSharedCargoTarget}from'./${BUILD}/shared-cargo-target.mjs';import{withCrateBuilds}from'./${BUILD}/build-crate-for-a-web-host.mjs';
const events=[];await Promise.all([withSharedCargoTarget('./${CRATES}',async()=>{events.push('first');await new Promise(r=>setTimeout(r,20));events.push('released')}),withSharedCargoTarget('./${CRATES}',()=>events.push('second'))]);
if(events.join(',')!=='first,released,second')throw new Error(events.join(','));let held;await withCrateBuilds(async builds=>{held=builds;await builds.webHost({crate:'workflow-engine',bindgenTarget:'web'})});
let refused=false;try{await held.webHost({crate:'workflow-engine'})}catch(error){refused=/scope has ended/.test(error.message)}if(!refused)throw new Error('escaped held builder');`;
    const result = await f.run(['--input-type=module', '-e', script]);
    assert.equal(result.code, 0, result.output);
    assert.equal(f.builds().length, 1);
  } finally { await f.done(); }
});

