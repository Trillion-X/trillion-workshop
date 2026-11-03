// The cache lock names its holder, and a lock left by a writer that died never blocks writes.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync, readFileSync, utimesSync, existsSync} from 'node:fs'
import {tmpdir, hostname} from 'node:os'
import {join, dirname} from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {holdCacheLock, releaseCacheLock, kernelOpenLocksIn, rememberedIn} from '../do-work/ask-for-a-verdict.mjs'

const MARKER = 'trillion.judge-cache-kernel-lock/v1\n'
const HELD = 'trillion.judge-cache-held-lock/v1\n'
// Each way is tested where the place reports it: a kernel open lock, or a lock held by its name.
const kernel = kernelOpenLocksIn(tmpdir())

function cachePath() { return join(mkdtempSync(join(tmpdir(), 'cache-lock-')), 'remembered.json') }

function holderOf(path) {
  const text = readFileSync(`${path}.lock`, 'utf8')
  assert.ok(text.startsWith(MARKER))
  return JSON.parse(text.slice(MARKER.length))
}

function withStderr(work) {
  const lines = []
  const write = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  try { return {value: work(), lines} } finally { process.stderr.write = write }
}

test('the lock names its holder: pid and start time', {skip: !kernel}, () => {
  const path = cachePath()
  const descriptor = holdCacheLock(path)
  try {
    const holder = holderOf(path)
    assert.equal(holder.pid, process.pid)
    assert.ok(Date.parse(holder.started) <= Date.now())
  } finally { releaseCacheLock(path, descriptor) }
})

test('an empty legacy lock older than any write, open in no process, is reclaimed with one log line', {skip: !kernel}, () => {
  const path = cachePath()
  writeFileSync(`${path}.lock`, '', {mode: 0o600})
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(`${path}.lock`, hourAgo, hourAgo)
  const {value: descriptor, lines} = withStderr(() => holdCacheLock(path))
  try {
    assert.equal(lines.length, 1)
    assert.match(lines[0], /reclaimed .*remembered\.json\.lock, an empty lock of the earlier protocol/)
    assert.equal(holderOf(path).pid, process.pid)
  } finally { releaseCacheLock(path, descriptor) }
})

test('a fresh empty legacy lock stays busy: its writer may still be working', {skip: !kernel}, () => {
  const path = cachePath()
  writeFileSync(`${path}.lock`, '', {mode: 0o600})
  assert.throws(() => holdCacheLock(path), {code: 'EAGAIN'})
  assert.equal(readFileSync(`${path}.lock`, 'utf8'), '')
})

test('an old empty legacy lock another process holds open stays busy', {skip: !kernel}, async () => {
  const path = cachePath()
  writeFileSync(`${path}.lock`, '', {mode: 0o600})
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(`${path}.lock`, hourAgo, hourAgo)
  const holder = spawn('sh', ['-c', 'exec 3<"$1"; echo held; exec sleep 30', 'sh', `${path}.lock`])
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject) })
    assert.throws(() => holdCacheLock(path), {code: 'EAGAIN'})
    assert.equal(readFileSync(`${path}.lock`, 'utf8'), '')
  } finally { holder.kill() }
})

test('a lock whose holder died is taken and its holder rewritten', {skip: !kernel}, () => {
  const path = cachePath()
  const dead = spawnSync('sh', ['-c', 'echo $$'], {encoding: 'utf8'})
  const deadPid = Number(dead.stdout.trim())
  writeFileSync(`${path}.lock`, `${MARKER}${JSON.stringify({pid: deadPid, started: new Date(0).toISOString()})}\n`, {mode: 0o600})
  const descriptor = holdCacheLock(path)
  try {
    assert.equal(holderOf(path).pid, process.pid)
  } finally { releaseCacheLock(path, descriptor) }
  // Released by close, so the next writer takes it.
  releaseCacheLock(path, holdCacheLock(path))
})

test('a lock without a valid holder line is refused, never rewritten', {skip: !kernel}, () => {
  const path = cachePath()
  const bad = `${MARKER}{"pid":"me"}\n`
  writeFileSync(`${path}.lock`, bad, {mode: 0o600})
  assert.throws(() => holdCacheLock(path), /protocol is unavailable/)
  assert.equal(readFileSync(`${path}.lock`, 'utf8'), bad)
})

// A place whose open(2) takes no kernel lock holds the lock by its name instead.
function heldHolderOf(path) {
  const text = readFileSync(`${path}.lock`, 'utf8')
  assert.ok(text.startsWith(HELD))
  return JSON.parse(text.slice(HELD.length))
}

test('held by name: the lock names its holder and place, refuses a second holder, and is gone once let go', {skip: kernel}, () => {
  const path = cachePath()
  const descriptor = holdCacheLock(path)
  try {
    const holder = heldHolderOf(path)
    assert.deepEqual([holder.pid, holder.place], [process.pid, hostname()])
    assert.throws(() => holdCacheLock(path), {code: 'EAGAIN'})
  } finally { releaseCacheLock(path, descriptor) }
  assert.equal(existsSync(`${path}.lock`), false)
  releaseCacheLock(path, holdCacheLock(path))
})

test('held by name: a lock whose holder ended on this place is taken, with one log line', {skip: kernel}, () => {
  const path = cachePath()
  const ended = Number(spawnSync('sh', ['-c', 'echo $$'], {encoding: 'utf8'}).stdout.trim())
  writeFileSync(`${path}.lock`, `${HELD}${JSON.stringify({pid: ended, started: new Date(0).toISOString(), place: hostname()})}\n`, {mode: 0o600})
  const {value: descriptor, lines} = withStderr(() => holdCacheLock(path))
  try {
    assert.equal(lines.length, 1)
    assert.match(lines[0], /reclaimed .*remembered\.json\.lock, held by process \d+ on this place, which has ended/)
    assert.equal(heldHolderOf(path).pid, process.pid)
  } finally { releaseCacheLock(path, descriptor) }
})

test('held by name: a lock held from another place sharing the folder is never taken', {skip: kernel}, () => {
  const path = cachePath()
  const other = `${HELD}${JSON.stringify({pid: 999999, started: new Date(0).toISOString(), place: `not-${hostname()}`})}\n`
  writeFileSync(`${path}.lock`, other, {mode: 0o600})
  assert.throws(() => holdCacheLock(path), {code: 'EAGAIN'})
  assert.equal(readFileSync(`${path}.lock`, 'utf8'), other)
})

test('held by name: a lock file of the kernel way, or of nothing known, stays and counts as busy', {skip: kernel}, () => {
  for (const text of ['', `${MARKER}${JSON.stringify({pid: 1, started: new Date(0).toISOString()})}\n`, 'not a lock\n']) {
    const path = cachePath()
    writeFileSync(`${path}.lock`, text, {mode: 0o600})
    assert.throws(() => holdCacheLock(path), {code: 'EAGAIN'})
    assert.equal(readFileSync(`${path}.lock`, 'utf8'), text)
  }
})

test('kept calibration is written and read back on any place, by whichever lock it reports', () => {
  const path = cachePath()
  const kept = rememberedIn(path)
  assert.equal(kept.set('one', {chosen: 'right'}).status, 'stored')
  assert.equal(kept.get('one').chosen, 'right')
  assert.equal(kept.availability().status, 'available')
  assert.equal(existsSync(`${path}.lock`), kernel, 'a lock held by name is gone once the write is done')
  assert.ok(existsSync(dirname(path)))
})
