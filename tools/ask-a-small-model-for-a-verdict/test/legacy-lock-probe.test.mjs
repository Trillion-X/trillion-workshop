import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import {test, mock} from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import { writeFileSync, utimesSync, readFileSync } from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {holdCacheLock, releaseCacheLock, kernelOpenLocksIn} from '../do-work/ask-for-a-verdict.mjs'

const kernel = kernelOpenLocksIn(tmpdir())

test('legacy recovery keeps the complete holder scan and five-second bound; unknown scans stay busy', {skip: !kernel}, () => {
  const cases = [
    {status: 0, stdout: `${process.pid}\n`, stderr: '', reclaim: true},
    {status: 1, stdout: '', stderr: '', reclaim: true},
    {status: 0, stdout: `${process.pid}\n999999\n`, stderr: ''},
    {status: 2, stdout: '', stderr: ''},
    {status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), {code: 'ETIMEDOUT'})},
    {status: null, stdout: '', stderr: '', error: Object.assign(new Error('unavailable'), {code: 'ENOENT'})},
    {status: 1, stdout: '', stderr: 'inspection unavailable\n'},
    {status: 0, stdout: 'not a PID\n', stderr: ''},
  ]
  for (const answer of cases) {
    const path = join(tempFolder(join(tmpdir(), 'legacy-lock-probe-')), 'cache.json')
    writeFileSync(`${path}.lock`, '', {mode: 0o600})
    const old = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(`${path}.lock`, old, old)
    const probe = mock.method(childProcess, 'spawnSync', (program, args, options) => {
      assert.equal(program, 'lsof')
      assert.deepEqual(args, ['-O', '-nP', '-l', '-t', '--', `${path}.lock`])
      assert.deepEqual(options, {encoding: 'utf8', timeout: 5000})
      return answer
    })
    syncBuiltinESMExports()
    try {
      if (answer.reclaim) releaseCacheLock(path, holdCacheLock(path))
      else {
        assert.throws(() => holdCacheLock(path), {code: 'EAGAIN'})
        assert.equal(readFileSync(`${path}.lock`, 'utf8'), '')
      }
      assert.equal(probe.mock.callCount(), 1)
    } finally {
      probe.mock.restore()
      syncBuiltinESMExports()
    }
  }
})
