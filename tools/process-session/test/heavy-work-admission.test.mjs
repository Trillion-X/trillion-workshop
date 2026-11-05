import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createProcessAdmissionQueue, identityOf, UNKNOWN_LIVE } from '../do-work/process-admission.mjs';
import { createHeavyWorkOwner, heavyWorkOwnerIsLive, HEAVY_WORK_CLAIM, verifiedHeavyWorkClaim } from '../do-work/heavy-work.mjs';

function stageTrace() {
  const events = []; const began = performance.now(); let pending = '';
  const keep = stage => { if (events.length < 100) events.push({ stage, elapsed_ms: Math.round(performance.now() - began) }); };
  return { events, options: { onStart: () => keep('outer-supervisor-bound'), onStage: stage => keep(stage), onStderr: text => {
    pending += text; const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) if (/^HEAVY_STAGE [a-z0-9_-]+$/.test(line)) keep(line.slice(12));
    pending = pending.slice(-200);
  } } };
}
async function reportStages(work, trace) {
  try { return await work(); }
  catch (error) { throw new Error(`Heavy-work failed at ${error.ownedProcessStage ?? 'unknown'}; stages=${JSON.stringify(trace.events)}`, { cause: error }); }
}

const moduleUrl = new URL(import.meta.resolve('../do-work/heavy-work.mjs')).href;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'trillion-heavy-work-'));
  return { root, queue: createProcessAdmissionQueue(root, { ownerIsLive: heavyWorkOwnerIsLive }), owner: createHeavyWorkOwner(root), close: () => rm(root, { recursive: true, force: true }) };
}

test('a retained foreign guard cannot collide with release or block the following waiter', async t => {
  const f = await fixture();
  const actualWrite = fs.writeFileSync;
  const retained = new Map();
  const peer = { pid: process.pid, process_started: identityOf(process.pid), token: 'retained-foreign-owner' };
  t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (String(path).startsWith(join(f.root, 'owner.json.'))) {
      const held = JSON.parse(fs.readFileSync(join(f.root, 'state.guard', 'owner.json'), 'utf8'));
      const destination = join(f.root, `state.guard.retired.${held.token}`);
      fs.mkdirSync(destination);
      const bytes = JSON.stringify(peer);
      actualWrite(join(destination, 'owner.json'), bytes);
      retained.set(destination, bytes);
    }
    return actualWrite(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const first = await f.queue.acquire({ timeoutMs: 3000 });
    assert.equal(existsSync(join(f.root, 'state.guard')), false, 'admission releases its short state lock');
    let admitted = false;
    const waiting = f.queue.acquire({ timeoutMs: 3000 });
    waiting.then(() => { admitted = true; });
    await pause(30);
    assert.equal(admitted, false, 'the heavy-work claim still excludes another job');
    await first();
    await (await waiting)();
    assert.equal(existsSync(join(f.root, 'state.guard')), false);
    assert.equal(existsSync(join(f.root, 'owner.json')), false);
    for (const [path, bytes] of retained) assert.equal(fs.readFileSync(join(path, 'owner.json'), 'utf8'), bytes);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});

test('build/test contention waits independently of browser admission', async () => {
  const f = await fixture();
  const browser = createProcessAdmissionQueue(join(f.root, 'browser'));
  try {
    const held = await f.queue.acquire({ timeoutMs: 3000 });
    const browserRelease = await browser.acquire({ timeoutMs: 3000 });
    const waiting = f.queue.acquire({ timeoutMs: 3000 });
    let admitted = false;
    waiting.then(() => { admitted = true; });
    await pause(30);
    assert.equal(admitted, false);
    await browserRelease();
    assert.equal(admitted, false);
    await held();
    await (await waiting)();
  } finally { await f.close(); }
});

test('cancelled queued heavy work leaves the live holder and no ticket', async () => {
  const f = await fixture();
  try {
    const held = await f.queue.acquire({ timeoutMs: 3000 });
    const abort = new AbortController();
    const waiting = f.queue.acquire({ timeoutMs: 3000, signal: abort.signal });
    abort.abort(new Error('queued work cancelled'));
    await assert.rejects(waiting, /queued work cancelled/);
    assert.equal(JSON.parse(await readFile(join(f.root, 'owner.json'), 'utf8')).token, held.claim.token);
    assert.deepEqual(await readdir(join(f.root, 'tickets')), []);
    await held();
  } finally { await f.close(); }
});

test('a dead embedding parent does not release a live bound supervisor', async () => {
  const f = await fixture();
  const saved = { pid: 2147483647, process_started: 'dead parent', token: 'old', group_id: process.pid, group_started: identityOf(process.pid) };
  try {
    await writeFile(join(f.root, 'owner.json'), JSON.stringify(saved));
    await assert.rejects(f.queue.acquire({ timeoutMs: 220 }), /Timed out/);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'owner.json'), 'utf8')), saved);
  } finally { await f.close(); }
});

test('PID reuse retires a stale holder, while unknown group probes stay closed', async () => {
  const f = await fixture();
  try {
    const saved = { pid: 812, process_started: 'previous parent', token: 'old', process_groups: [{ group_id: 813, group_started: 'previous group' }] };
    await writeFile(join(f.root, 'owner.json'), JSON.stringify(saved));
    const inspect = pid => pid === process.pid ? 'current test' : pid === 812 ? 'new parent incarnation' : pid === 813 ? UNKNOWN_LIVE : null;
    const queue = createProcessAdmissionQueue(f.root, { inspectProcess: inspect, ownerIsLive: heavyWorkOwnerIsLive });
    await assert.rejects(queue.acquire({ timeoutMs: 220 }), /Timed out/);
    const reclaimed = createProcessAdmissionQueue(f.root, { inspectProcess: pid => pid === 813 ? 'new group incarnation' : inspect(pid), ownerIsLive: heavyWorkOwnerIsLive });
    await (await reclaimed.acquire({ timeoutMs: 3000 }))();
  } finally { await f.close(); }
});

function inheritedFixture() {
  const claim = { token: 'held', pid: 10, process_started: 'parent' };
  const owner = { ...claim, process_groups: [{ group_id: 20, group_started: 'supervisor' }] };
  const env = { [HEAVY_WORK_CLAIM]: JSON.stringify(claim) };
  const inspect = pid => pid === 10 ? 'parent' : pid === 20 ? 'supervisor' : null;
  const relation = pid => ({ 30: { parent: 25, group: 20 }, 25: { parent: 20, group: 20 }, 20: { parent: 10, group: 20 } })[pid] ?? null;
  return { owner, options: { env, pid: 30, inspect, relation }, claim };
}

test('nested descendants reuse only an exact live token, owner, group and ancestry', () => {
  const f = inheritedFixture();
  assert.deepEqual(verifiedHeavyWorkClaim(f.owner, f.options), f.claim);
  assert.equal(verifiedHeavyWorkClaim({ ...f.owner, token: 'replacement' }, f.options), null);
  assert.equal(verifiedHeavyWorkClaim(f.owner, { ...f.options, inspect: pid => pid === 10 ? 'reused parent' : f.options.inspect(pid) }), null);
  assert.equal(verifiedHeavyWorkClaim(f.owner, { ...f.options, inspect: () => UNKNOWN_LIVE }), null);
  assert.equal(verifiedHeavyWorkClaim(f.owner, { ...f.options, env: { [HEAVY_WORK_CLAIM]: '{broken' } }), null);
});

test('copied claim in a detached group or unrelated ancestry is refused', () => {
  const f = inheritedFixture();
  assert.equal(verifiedHeavyWorkClaim(f.owner, { ...f.options, relation: pid => pid === 30 ? { parent: 25, group: 30 } : f.options.relation(pid) }), null);
  assert.equal(verifiedHeavyWorkClaim(f.owner, { ...f.options, relation: pid => pid === 25 ? { parent: 1, group: 20 } : f.options.relation(pid) }), null);
  assert.equal(verifiedHeavyWorkClaim(f.owner, { ...f.options, relation: () => null }), null);
});

test('async ownership registration completes before command startup and honors cwd', { timeout: 12000 }, async () => {
  const f = await fixture();
  const marker = join(f.root, 'registration');
  try {
    const text = await f.owner.run(process.execPath, ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(marker)},'utf8')+'|'+process.cwd())`], {
      cwd: f.root, timeoutMs: 5000, onStart: async () => { await pause(40); await writeFile(marker, 'bound'); },
    });
    assert.equal(text, `bound|${await realpath(f.root)}`);
    assert.equal(existsSync(join(f.root, 'owner.json')), false);
  } finally { await f.close(); }
});

test('failed async registration never starts its command', { timeout: 12000 }, async () => {
  const f = await fixture();
  const marker = join(f.root, 'must-not-start');
  try {
    await assert.rejects(f.owner.run(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], {
      timeoutMs: 5000, onStart: async () => { await pause(30); throw new Error('registration rejected'); },
    }), /registration rejected/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(f.root, 'owner.json')), false);
  } finally { await f.close(); }
});

test('nested owned helpers run without reacquisition deadlock', { timeout: 15000 }, async () => {
  const f = await fixture(); const trace = stageTrace();
  const code = `const mark=stage=>process.stderr.write('HEAVY_STAGE '+stage+'\\n'); mark('nested-child-enter'); mark(process.env.NODE_TEST_CONTEXT?'test-context-present':'test-context-absent'); const assert=(await import('node:assert/strict')).default; const {createHeavyWorkOwner}=await import(${JSON.stringify(moduleUrl)}); mark('nested-imported'); const owner=createHeavyWorkOwner(process.argv[1]); mark('nested-owner-created'); mark('nested-before-inherited'); assert.ok(owner.inherited(process.env)); mark('nested-after-inherited'); const text=await owner.run(process.execPath,['-e','process.stdout.write("nested")'],{timeoutMs:5000,admissionTimeoutMs:500,onStage:stage=>mark('inner-'+stage)}); mark('nested-finished'); process.stdout.write(text);`;
  try {
    assert.equal(await reportStages(() => f.owner.run(process.execPath, ['--input-type=module', '-e', code, f.root], { timeoutMs: 10000, ...trace.options }), trace), 'nested');
    assert.equal(existsSync(join(f.root, 'owner.json')), false);
  } finally { await f.close(); }
});

test('an independent detached job with copied environment must wait for its own slot', { timeout: 15000 }, async () => {
  const f = await fixture(); const trace = stageTrace();
  const detached = `const mark=stage=>process.stderr.write('HEAVY_STAGE '+stage+'\\n'); mark('detached-enter'); mark(process.env.NODE_TEST_CONTEXT?'test-context-present':'test-context-absent'); const assert=(await import('node:assert/strict')).default; const {createHeavyWorkOwner}=await import(${JSON.stringify(moduleUrl)}); mark('detached-imported'); const owner=createHeavyWorkOwner(process.argv[1]); mark('detached-before-inherited'); assert.equal(owner.inherited(process.env),null); mark('detached-after-inherited'); await assert.rejects(owner.run(process.execPath,['-e','process.stdout.write("must not start")'],{admissionTimeoutMs:220,timeoutMs:1000}),/Timed out/); mark('detached-refused'); process.stdout.write('independent');`;
  const code = `const mark=stage=>process.stderr.write('HEAVY_STAGE '+stage+'\\n'); mark('detached-parent-enter'); const {spawn}=await import('node:child_process'); const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(detached)},process.argv[1]],{detached:true,stdio:['ignore','pipe','pipe'],env:process.env}); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.once('error',()=>{mark('detached-spawn-error');process.exitCode=1;}); child.once('exit',code=>{mark('detached-exit');process.exitCode=code;});`;
  try {
    assert.equal(await reportStages(() => f.owner.run(process.execPath, ['--input-type=module', '-e', code, f.root], { timeoutMs: 10000, ...trace.options }), trace), 'independent');
    assert.deepEqual(await readdir(join(f.root, 'tickets')), []);
  } finally { await f.close(); }
});

test('invalid input is rejected before an owned supervisor starts', { timeout: 12000 }, async () => {
  const f = await fixture(); let started = false;
  try {
    const input = { pipe() {}, unpipe() {} };
    await assert.rejects(f.owner.run(process.execPath, ['-e', 'process.stdout.write("must not start")'], { input, timeoutMs: 5000, onStart: () => { started = true; } }), /Process input must be a readable stream/);
    assert.equal(started, false);
    assert.equal(existsSync(join(f.root, 'owner.json')), false);
  } finally { await f.close(); }
});

test('command input streams through a private pipe without ending lifetime ownership at EOF', { timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    const input = Readable.from(['synthetic-', 'input']);
    const code = 'let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>setTimeout(()=>process.stdout.write(text+"|after-eof"),40));';
    assert.equal(await f.owner.run(process.execPath, ['-e', code], { input, timeoutMs: 5000 }), 'synthetic-input|after-eof');
    assert.equal(existsSync(join(f.root, 'owner.json')), false);
  } finally { await f.close(); }
});

test('active cancellation stops an owned SIGTERM-ignoring worker before release', { timeout: 15000 }, async () => {
  const f = await fixture();
  const abort = new AbortController(); const input = new PassThrough();
  let worker;
  try {
    const running = f.owner.run(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)'], {
      timeoutMs: 10000, graceMs: 30, signal: abort.signal, input,
      onStdout: text => { worker = Number(text); abort.abort(new Error('active work cancelled')); },
    });
    await assert.rejects(running, /active work cancelled/);
    assert.ok(worker > 0);
    assert.equal(input.destroyed, false);
    assert.equal(input.listenerCount('error'), 0);
    assert.equal(identityOf(worker), null);
    assert.equal(existsSync(join(f.root, 'owner.json')), false);
  } finally { await f.close(); }
});

test('parent pipe closure stops the bound supervisor and frees stale admission', { timeout: 20000 }, async () => {
  const f = await fixture();
  const pidFile = join(f.root, 'worker.pid');
  const code = `import {createHeavyWorkOwner} from ${JSON.stringify(moduleUrl)}; await createHeavyWorkOwner(process.argv[1]).run(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`)}],{timeoutMs:15000});`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code, f.root], { stdio: 'ignore' });
  const ended = new Promise(resolve => parent.once('exit', resolve));
  try {
    const deadline = Date.now() + 6000;
    while (!existsSync(pidFile) && Date.now() < deadline) await pause(20);
    assert.equal(existsSync(pidFile), true);
    const worker = Number(await readFile(pidFile, 'utf8'));
    parent.kill('SIGKILL');
    await ended;
    await (await f.queue.acquire({ timeoutMs: 6000 }))();
    assert.equal(identityOf(worker), null);
  } finally { parent.kill('SIGKILL'); await f.close(); }
});

test('a waiting job leaves the current owner state lock available for process registration', async t => {
  const f = await fixture();
  const held = await f.queue.acquire({timeoutMs:3000});
  const actualRead=fs.readFileSync,actualMkdir=fs.mkdirSync,observed=Promise.withResolvers();
  let ownerReads=0,stateWrites=0;
  t.mock.method(fs,'readFileSync',(path,...args)=>{
    const answer=actualRead(path,...args);
    if(String(path)===join(f.root,'owner.json')&&++ownerReads===2)observed.resolve();
    return answer;
  });
  t.mock.method(fs,'mkdirSync',(path,...args)=>{
    if(String(path).startsWith(join(f.root,'state.guard.staging.')))stateWrites++;
    return actualMkdir(path,...args);
  });
  syncBuiltinESMExports();
  const abort=new AbortController();
  const waiting=f.queue.acquire({timeoutMs:3000,signal:abort.signal});
  const stopped=assert.rejects(waiting,/waiting check cancelled/);
  try {
    await Promise.race([observed.promise,waiting]);
    assert.equal(stateWrites,0,'a known-busy waiter must not compete for the holder registration lock');
    assert.equal(JSON.parse(actualRead(join(f.root,'owner.json'),'utf8')).token,held.claim.token);
  } finally {
    abort.abort(new Error('waiting check cancelled'));await stopped;
    t.mock.restoreAll();syncBuiltinESMExports();
    await held();await f.close();
  }
});

for (const [label, window, expectedFirst] of [['aged waiters',0,'older'],['fresh waiters',300000,'urgent']]) {
  test(`priority overtaking respects ${label} without changing existing tickets or the live owner`, { timeout: 12000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'trillion-admission-priority-'));
    const queue = createProcessAdmissionQueue(root, { maxPriorityOvertakeMs: window });
    const abort = new AbortController(), pending = [], releases = [];
    try {
      const held = await queue.acquire({ timeoutMs: 5000 });releases.push(held);
      const ownerBefore = await readFile(join(root, 'owner.json'), 'utf8');
      const enqueue = (name, priority) => {
        const job = queue.acquire({ priority, timeoutMs: 7000, signal: abort.signal }).then(release => {
          releases.push(release);return { name, release };
        });
        pending.push(job);return job;
      };
      const older = enqueue('older',0);
      const oldName = (await readdir(join(root,'tickets'))).find(name=>name.endsWith('.json'));
      const oldBytes = await readFile(join(root,'tickets',oldName),'utf8');
      await pause(3);
      const urgent = enqueue('urgent',999999);
      const entries = await Promise.all((await readdir(join(root,'tickets'))).filter(name=>name.endsWith('.json')).map(name=>readFile(join(root,'tickets',name),'utf8').then(JSON.parse)));
      assert.equal(await readFile(join(root,'tickets',oldName),'utf8'),oldBytes,'existing legacy queue clients retain their exact original ticket');
      assert.equal(await readFile(join(root,'owner.json'),'utf8'),ownerBefore,'priority changes never preempt a live owner');
      const newest=entries.find(row=>row.id!==JSON.parse(oldBytes).id);
      assert.equal(newest.priority,window===0?0:999999,'the persisted priority is understood by the original comparator');
      if(window===0) assert.equal(newest.requested_priority,999999);
      await held();
      const first=await Promise.race([older,urgent]);
      assert.equal(first.name,expectedFirst);
      assert.equal(queue.readOwner().token,first.release.claim.token);
      await first.release();
      const second=await (first.name==='older'?urgent:older);
      assert.notEqual(second.name,first.name);
      await second.release();
      assert.equal(queue.readOwner(),null);
    } finally {
      abort.abort(new Error('priority fixture finished'));
      await Promise.allSettled(releases.map(release=>release()));
      await Promise.allSettled(pending);
      await rm(root,{recursive:true,force:true});
    }
  });
}
