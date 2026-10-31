// The cache lock names its holder, and a lock left by a writer that died never blocks writes.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync, readFileSync, utimesSync, closeSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {holdCacheLock} from '../do-work/ask-for-a-verdict.mjs'

const MARKER = 'trillion.judge-cache-kernel-lock/v1\n'
const darwin = process.platform === 'darwin'

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

test('the lock names its holder: pid and start time', {skip: !darwin}, () => {
  const path = cachePath()
  const descriptor = holdCacheLock(path)
  try {
    const holder = holderOf(path)
    assert.equal(holder.pid, process.pid)
    assert.ok(Date.parse(holder.started) <= Date.now())
  } finally { closeSync(descriptor) }
})

test('an empty legacy lock older than any write, open in no process, is reclaimed with one log line', {skip: !darwin}, () => {
  const path = cachePath()
  writeFileSync(`${path}.lock`, '', {mode: 0o600})
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(`${path}.lock`, hourAgo, hourAgo)
  const {value: descriptor, lines} = withStderr(() => holdCacheLock(path))
  try {
    assert.equal(lines.length, 1)
    assert.match(lines[0], /reclaimed .*remembered\.json\.lock, an empty lock of the earlier protocol/)
    assert.equal(holderOf(path).pid, process.pid)
  } finally { closeSync(descriptor) }
})

test('a fresh empty legacy lock stays busy: its writer may still be working', {skip: !darwin}, () => {
  const path = cachePath()
  writeFileSync(`${path}.lock`, '', {mode: 0o600})
  assert.throws(() => holdCacheLock(path), {code: 'EAGAIN'})
  assert.equal(readFileSync(`${path}.lock`, 'utf8'), '')
})

test('an old empty legacy lock another process holds open stays busy', {skip: !darwin}, async () => {
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

test('a lock whose holder died is taken and its holder rewritten', {skip: !darwin}, () => {
  const path = cachePath()
  const dead = spawnSync('sh', ['-c', 'echo $$'], {encoding: 'utf8'})
  const deadPid = Number(dead.stdout.trim())
  writeFileSync(`${path}.lock`, `${MARKER}${JSON.stringify({pid: deadPid, started: new Date(0).toISOString()})}\n`, {mode: 0o600})
  const descriptor = holdCacheLock(path)
  try {
    assert.equal(holderOf(path).pid, process.pid)
  } finally { closeSync(descriptor) }
  // Released by close, so the next writer takes it.
  closeSync(holdCacheLock(path))
})

test('a lock without a valid holder line is refused, never rewritten', {skip: !darwin}, () => {
  const path = cachePath()
  const bad = `${MARKER}{"pid":"me"}\n`
  writeFileSync(`${path}.lock`, bad, {mode: 0o600})
  assert.throws(() => holdCacheLock(path), /protocol is unavailable/)
  assert.equal(readFileSync(`${path}.lock`, 'utf8'), bad)
})
