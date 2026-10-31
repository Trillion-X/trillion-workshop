// Finite append observation and bounded regular-file reads in the existing journal,
// never a second event store. Descriptor identity checks catch ordinary replacement;
// they do not attest the writer or make filesystem syscalls atomic/preemptible.
import {openSync, closeSync, readSync, fstatSync, lstatSync, constants} from 'node:fs'
import {performance} from 'node:perf_hooks'
import {blake3Material} from './ask-for-a-verdict.mjs'

const schema = 'trillion.judge-log-frontier/v1'
const maxBytes = 2 * 1024 * 1024
// The writer compacts above twice its 64 MiB live bound, preserving full history until then.
export const maxRegularReadBytes = 128 * 1024 * 1024
// Cache and coverage JSON use the same 64 MiB finite bound as rememberedIn.
export const maxStructuredReadBytes = 64 * 1024 * 1024
const maxRegularReadMillis = 5000
const natural = value => Number.isSafeInteger(value) && value >= 0
const valid = value => value?.schema === schema && [value.device, value.inode, value.bytes].every(natural)
  && typeof value.anchor === 'string' && /^blake3:[0-9a-f]{64}$/.test(value.anchor)
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key])
const read = (fd, start, length) => {
  const bytes = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const count = readSync(fd, bytes, done, length - done, start + done)
    if (!count) throw new Error('short-read')
    done += count
  }
  return bytes
}
const anchor = (fd, end) => `blake3:${blake3Material(read(fd, Math.max(0, end - 4096), Math.min(4096, end)))}`
const boundary = (fd, end) => end === 0 || read(fd, end - 1, 1)[0] === 10
const frontierAt = (fd, stat, bytes) => ({schema, device: stat.dev, inode: stat.ino, bytes, anchor: anchor(fd, bytes)})
const open = path => {
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) throw new Error('unsupported-open-flags')
  // fstat cannot refuse a pipe if opening that pipe already blocked.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || ![stat.dev, stat.ino, stat.size].every(natural) || !same(stat, lstatSync(path)))
      throw new Error('file-unavailable')
    return {fd, stat}
  } catch (error) {closeSync(fd); throw error}
}
const stable = (path, fd, stat) => same(stat, fstatSync(fd)) && same(stat, lstatSync(path))

/** Read a complete bounded regular file from one nonblocking, no-follow descriptor.
 * The cap bounds allocation and progress-loop work. Individual OS syscalls cannot
 * be preempted, and same-stat checks are not an atomic filesystem snapshot. */
export function readJudgeLogFile(path, limit = maxRegularReadBytes) {
  let fd
  try {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > maxRegularReadBytes) return {status: 'unavailable', reason: 'invalid-read-limit'}
    const opened = open(path); fd = opened.fd
    if (opened.stat.size > limit) return {status: 'unavailable', reason: 'size-limit-exceeded'}
    const bytes = Buffer.alloc(opened.stat.size)
    let done = 0
    const deadline = performance.now() + maxRegularReadMillis
    while (done < bytes.length) {
      if (performance.now() > deadline) return {status: 'unavailable', reason: 'read-budget-exceeded'}
      const count = readSync(fd, bytes, done, bytes.length - done, done)
      if (!count) return {status: 'unavailable', reason: 'short-read'}
      done += count
      if (performance.now() > deadline) return {status: 'unavailable', reason: 'read-budget-exceeded'}
    }
    if (!stable(path, fd, opened.stat)) return {status: 'unavailable', reason: 'changed-during-read'}
    return {status: 'read', bytes}
  } catch (error) {
    return {status: 'unavailable', reason: error?.message === 'unsupported-open-flags'
      ? 'unsupported-open-flags' : 'file-or-identity-unavailable'}
  } finally {if (fd !== undefined) closeSync(fd)}
}

export function captureJudgeLogFrontier(path) {
  let fd
  try {
    const opened = open(path); fd = opened.fd
    if (!boundary(fd, opened.stat.size)) return {status: 'unavailable', reason: 'incomplete-boundary'}
    const frontier = frontierAt(fd, opened.stat, opened.stat.size)
    if (!stable(path, fd, opened.stat)) return {status: 'unavailable', reason: 'changed-during-read'}
    return {status: 'captured', scope: 'same-file append frontier; no writer or caller attestation', frontier}
  } catch {return {status: 'unavailable', reason: 'file-or-identity-unavailable'}}
  finally {if (fd !== undefined) closeSync(fd)}
}

export function readJudgeLogFrontierFile(path) {
  let fd
  try {
    const opened = open(path); fd = opened.fd
    if (opened.stat.size > 4096) return null
    const saved = JSON.parse(read(fd, 0, opened.stat.size).toString('utf8'))
    const frontier = saved?.status === 'captured' ? saved.frontier : saved
    return stable(path, fd, opened.stat) && valid(frontier) ? frontier : null
  } catch {return null}
  finally {if (fd !== undefined) closeSync(fd)}
}

export function readJudgeLogAppend(path, frontier) {
  const source = {status: 'unavailable-or-incomplete', observation: 'bounded-append', read_includes_archive: false}
  const unknown = reason => ({source: {...source, reason}, lines: []})
  if (!valid(frontier)) return unknown('frontier-invalid')
  let fd
  try {
    const opened = open(path); fd = opened.fd
    const before = opened.stat
    if (before.dev !== frontier.device || before.ino !== frontier.inode || before.size < frontier.bytes)
      return unknown('file-identity-or-size-changed')
    if (!boundary(fd, frontier.bytes) || anchor(fd, frontier.bytes) !== frontier.anchor)
      return unknown('frontier-boundary-or-anchor-changed')
    const length = before.size - frontier.bytes
    if (length > maxBytes) return unknown('append-bound-exceeded')
    const bytes = read(fd, frontier.bytes, length)
    const completeLength = bytes.lastIndexOf(10) + 1
    const next = frontierAt(fd, before, frontier.bytes + completeLength)
    if (!stable(path, fd, before)) return unknown('changed-during-read')
    return {source: {...source, status: 'read', bytes_at_open: before.size,
      start_byte: frontier.bytes, complete_bytes_observed: completeLength,
      incomplete_tail_bytes: length - completeLength, changed_during_read: false, next_frontier: next},
      lines: bytes.subarray(0, completeLength).toString('utf8').split('\n')}
  } catch {return unknown('file-or-identity-unavailable')}
  finally {if (fd !== undefined) closeSync(fd)}
}
