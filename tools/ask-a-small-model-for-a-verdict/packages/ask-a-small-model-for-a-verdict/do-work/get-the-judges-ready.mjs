#!/usr/bin/env node
// packages/ask-a-small-model-for-a-verdict/do-work/get-the-judges-ready.mjs
//
// Purpose
//   Everything slow about a judge, done once and away from the turn: start the
//   local servers the rubric file declares, then calibrate every rubric against
//   every judge on offer and keep the result where the turn hook reads it.
//
// Why it is separate from the turn
//   The turn hook has five seconds. Calibrating the local judges takes minutes,
//   so calibrating inside the hook was cut off every time, kept nothing, and
//   started over on the next turn: on 2026-09-26, 20,000 turns in a row ended
//   with no verdict. The hook now only reads what this run kept, and starts
//   this run when there is nothing to read.
//
// Why servers start here
//   A server a judge needs is declared on its provider row as `start_with`
//   (which model, which of this package's servers, which port). Starting it
//   when a judge is needed and it is not answering is what keeps it available
//   across restarts and crashes with no launch file written by hand.
//
// Invariants
//   - One run at a time: a lock beside the kept results. A second caller finds
//     the lock and leaves; a lock older than `stale_after_minutes`, or whose
//     process is gone, is taken over.
//   - Calibration passes are the turn's (1), so the result is filed under the
//     key the turn reads.
//   - It writes only the kept calibration results and its lock.
//
// Usage
//   get-the-judges-ready.mjs --rubrics <path> --remember <path> [--passes 1]

import {readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import {dirname} from 'node:path'
import {spawn} from 'node:child_process'
import {fileURLToPath, pathToFileURL } from 'node:url'
import {checkRubric, chooseCandidate, rememberedIn} from '../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-for-a-verdict.mjs'
import {providersIn, whoCanBeAsked} from './who-can-be-asked.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  return {rubrics: values.get('rubrics'), remember: values.get('remember'), passes: Number(values.get('passes') || 1)}
}

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

/** Take the lock, or return false when another live run holds it. */
export function takeLock(path, staleMinutes = 30, now = Date.now()) {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'))
    if (alive(held.pid) && now - Date.parse(held.at) < staleMinutes * 60000) return false
  } catch {}
  mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, JSON.stringify({pid: process.pid, at: new Date(now).toISOString()}))
  return true
}

/** Start this run in the background unless one is already going. Used by the turn hook. */
export function startInTheBackground({rubrics, remember}) {
  const lock = `${remember}.getting-ready`
  try {
    const held = JSON.parse(readFileSync(lock, 'utf8'))
    if (alive(held.pid) && Date.now() - Date.parse(held.at) < 30 * 60000) return false
  } catch {}
  const child = spawn(process.execPath, [`${here}/get-the-judges-ready.mjs`, '--rubrics', rubrics, '--remember', remember], {detached: true, stdio: 'ignore'})
  child.unref()
  return true
}

async function startServers(settings) {
  for (const row of providersIn(settings)) {
    const start = row.start_with
    if (!start?.model) continue
    const args = [`${here}/serve-a-local-classifier.mjs`, '--model', start.model, '--port', String(start.port ?? 8099), '--wait-seconds', String(start.wait_seconds ?? 600)]
    if (start.server) args.push('--server', start.server)
    await new Promise(resolve => spawn(process.execPath, args, {stdio: 'inherit'}).on('exit', resolve))
  }
}

export async function main(argv) {
  const {rubrics, remember, passes} = readArguments(argv)
  if (!rubrics || !remember) {
    process.stderr.write('usage: get-the-judges-ready.mjs --rubrics <path> --remember <path> [--passes 1]\n')
    return 1
  }
  const settings = JSON.parse(readFileSync(rubrics, 'utf8'))
  const lock = `${remember}.getting-ready`
  if (!takeLock(lock, settings.getting_ready?.stale_after_minutes ?? 30)) {
    process.stdout.write('another run is already getting the judges ready\n')
    return 0
  }
  try {
    await startServers(settings)
    const asking = await whoCanBeAsked(settings, {phase: 'calibration'})
    const candidates = asking.map(one => one.candidate)
    const ask = args => asking.find(one => one.candidate.name === args.candidate.name).ask(args)
    const keep = rememberedIn(remember)
    for (const rubric of settings.rubrics ?? []) {
      const started = Date.now()
      try {
        const {chosen, scoreboard} = await chooseCandidate({candidates, rubric: checkRubric(rubric), ask, passes, remember: keep})
        process.stdout.write(`${rubric.id}: ${chosen.name} (${scoreboard.map(row => `${row.candidate} ${row.correct}/${row.attempts}`).join(', ')}) in ${Date.now() - started} ms\n`)
      } catch (error) {
        process.stdout.write(`${rubric.id}: ${error.message}\n`)
      }
    }
  } finally {
    if (existsSync(lock)) rmSync(lock, {force: true})
  }
  return 0
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { process.stderr.write(`${error.message}\n`); process.exit(1) })
}
