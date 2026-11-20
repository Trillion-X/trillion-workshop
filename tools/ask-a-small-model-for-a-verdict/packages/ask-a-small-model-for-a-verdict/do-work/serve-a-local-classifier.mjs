#!/usr/bin/env node
// packages/ask-a-small-model-for-a-verdict/do-work/serve-a-local-classifier.mjs
//
// Purpose
//   Start a locally downloaded classifier as an HTTP service speaking the same
//   request shape as the hosted one, so the same adapter drives either.
//
// Why this is a package capability and not a shell line
//   Starting it needs an interpreter path and an environment, and a runtime
//   downloaded into a cache directory is not an owner root, so nothing here is
//   reachable by typing a command. It is reachable by an owner that knows how
//   to start it. That owner is this file.
//
// Why it matters that the local one speaks the hosted shape
//   The hosted service and this one then differ only in a URL. No branch, no
//   second adapter, no "if local" anywhere. Which one answers becomes a
//   question of which one passes calibration, which is the only question worth
//   asking about a judge.
//
// It starts a process and reports where it is listening. It writes nothing.
//
// Usage
//   serve-a-local-classifier.mjs [--model <repo id>] [--port 8099] [--wait-seconds 240]
//     [--server serve_a_local_classifier.py]   which of this package's servers runs the model
//     [--log <path>]                            where the server's own output goes
//
// The server outlives this process. Its output goes to a file rather than to a
// pipe back to here, because a pipe to a process that has exited kills the
// writer on its next line: the first version started a server that died the
// first time it printed after this owner returned.
//
// Asking for a server that is already answering starts nothing and says so,
// which is what lets any number of callers ask for it at once.

import {spawn} from 'node:child_process'
import {readdirSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import {join, dirname} from 'node:path'
import {homedir} from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url';

const CACHE = join(homedir(), '.cache', 'huggingface', 'hub')

/**
 * Where a downloaded model actually sits. The cache keeps each revision under
 * its own directory, so the newest one is the one that was just fetched.
 */
export function findDownloaded(repoId, cache = CACHE) {
  const folder = join(cache, `models--${repoId.replace('/', '--')}`, 'snapshots')
  if (!existsSync(folder)) return null
  const revisions = readdirSync(folder)
  if (revisions.length === 0) return null
  const newest = revisions
    .map(name => ({name, at: existsSync(join(folder, name)) ? 0 : -1}))
    .filter(one => one.at === 0)
    .pop()
  return newest ? join(folder, newest.name) : null
}

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  const model = values.get('model') || 'Mapika/decider-2b'
  return {
    model,
    port: Number(values.get('port') || 8099),
    waitSeconds: Number(values.get('wait-seconds') || 240),
    server: values.get('server') || 'serve_a_local_classifier.py',
    log: values.get('log') || join(homedir(), 'Library', 'Logs', 'ask-a-small-model-for-a-verdict', `${model.replace('/', '--')}.log`),
  }
}

async function readyAt(url, waitSeconds) {
  const until = Date.now() + waitSeconds * 1000
  while (Date.now() < until) {
    try {
      // Any answer at all means the server is up. A rejection on an empty body
      // is still an answer, and a refused connection is not.
      await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})
      return true
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }
  return false
}

async function answers(url) {
  try {
    await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}', signal: AbortSignal.timeout(2000)})
    return true
  } catch {
    return false
  }
}

export async function main(argv) {
  const {model, port, waitSeconds, server, log} = readArguments(argv)
  const endpoint = `http://127.0.0.1:${port}/v1/systemone`
  if (await answers(endpoint)) {
    process.stdout.write(JSON.stringify({serving: model, endpoint, listening: true, started: false}, null, 2) + '\n')
    return 0
  }
  const where = findDownloaded(model)
  if (!where) {
    process.stderr.write(`${model} is not downloaded. Nothing to serve.\n`)
    return 1
  }
  mkdirSync(dirname(log), {recursive: true})
  const output = openSync(log, 'a')

  const child = spawn(
    'python3',
    // Our own server rather than the runtime's, because that one hardcodes a
    // CUDA device and dies before it binds a port on a machine without one.
    [fileURLToPath(new URL(server, import.meta.url))],
    {
      cwd: where,
      // The environment goes through the spawn rather than a shell prefix, so
      // the model to load and the import path are arguments to a process this
      // owner starts, not a command anyone types.
      env: {...process.env, PYTHONPATH: where, SERVE_MODEL_PATH: where, SERVE_PORT: String(port)},
      detached: true,
      // Keep what it says. A server owner that discards the reason its child
      // died reports "not listening" and nothing else, which is the same
      // defect as a judgement with no record: the failure is real and the
      // explanation was thrown away.
      stdio: ['ignore', output, output],
    },
  )
  child.unref()

  const up = await readyAt(endpoint, waitSeconds)
  const saidSoFar = up ? [] : [readFileSync(log, 'utf8').slice(-6000)]
  process.stdout.write(
    JSON.stringify(
      {
        serving: model,
        from: where,
        endpoint,
        listening: up,
        started: true,
        log,
        // Everything the adapter needs to prefer this over the hosted one.
        use_it_by_setting: {CLASSIFIER_ENDPOINT: endpoint, CLASSIFIER_MODEL: model, CLASSIFIER_API_KEY: 'local'},
        ...(up ? {} : {it_said: saidSoFar.join('').trim().split('\n').slice(-25)}),
      },
      null,
      2,
    ) + '\n',
  )
  return up ? 0 : 1
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  main(process.argv.slice(2)).then(code => process.exit(code))
}