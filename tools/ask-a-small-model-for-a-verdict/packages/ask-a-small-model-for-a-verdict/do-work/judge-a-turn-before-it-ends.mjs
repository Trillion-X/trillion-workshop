#!/usr/bin/env node
// packages/ask-a-small-model-for-a-verdict/do-work/judge-a-turn-before-it-ends.mjs
//
// Purpose
//   Ask a calibrated classifier whether an agent turn did what it claims,
//   before that turn is allowed to end.
//
// Why this is the missing half
//   Plenty of things here check whether code compiles, whether tests pass,
//   whether a path is allowed. Nothing checks whether the agent's own ACCOUNT
//   of its work is true. That gap is why "I fixed it" and "I said I fixed it"
//   have looked identical from outside.
//
// Why a classifier rather than a phrase list
//   The failures worth catching are judgements. "I'll flag this and move on"
//   is one costume of handing work back and the next costume has not been
//   written yet, so a phrase list only ever catches the members someone
//   already thought of. The condition is a judgement, so the judge is
//   something that makes judgements, held to cases that prove it makes THIS
//   one correctly.
//
// Why it is safe to run on every turn
//   The classifier chooses among options it was handed. It cannot invent a
//   complaint about a file that does not exist and it cannot rewrite the turn.
//   The worst it can do is be wrong about raising a flag, which is bounded and
//   has a guardrail: the band.
//
// Why it fails open
//   A quality check that wedges every session when a model server is down is a
//   worse defect than the one it was added to catch. Any failure to reach a
//   classifier, any refusal, any rubric that will not calibrate, and the turn
//   ends normally with the reason written to the log. The log is the point: a
//   judgement nobody can go back to is not oversight, and something acted on
//   without a trace can never be found to have been wrong.
//
// It knows nothing about any particular harness. Where the rubrics live, where
// the transcript is and where to write the log are all arguments.
//
// Usage
//   judge-a-turn-before-it-ends.mjs --rubrics <path> --log <path>
//     [--transcript <path>]        otherwise read from the hook JSON on stdin
//
// Exit codes
//   0  let the turn end
//   2  block it, with the reason on stderr for the agent to read

import {readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {homedir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {judge, VerdictRefused, NotCalibratedYet, rememberedIn} from '../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-for-a-verdict.mjs'
import {whoCanBeAsked} from './who-can-be-asked.mjs'
import {startInTheBackground} from './get-the-judges-ready.mjs'
import {
  KEEP_CHARACTERS,
  readMemory,
  writeMemory,
  shapesFor,
  whichShape,
  noteIt,
  whatToSay,
} from './remember-what-was-already-said.mjs'

function readArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  return {
    rubrics: values.get('rubrics'),
    log: values.get('log'),
    transcript: values.get('transcript'),
    // Which rubrics to run. DATA marks each one, so when a question is worth
    // asking is a property of the question rather than of the hook that fires.
    when: values.get('when') || 'ending',
    // Mid-turn, only re-ask once the turn has actually said something new.
    // Without this the same unchanged text is judged after every tool call,
    // which costs real money to learn nothing and trains everyone to ignore it.
    minNewCharacters: Number(values.get('min-new-characters') || 0),
    sinceFile: values.get('since-file'),
    // Where to keep track of what has already been said. Without it every
    // correction is delivered as though it were the first one.
    memory: values.get('memory'),
    // Where to keep calibration outcomes, so the expensive part is not redone
    // on every fire for a rubric nothing has touched.
    remember: values.get('remember'),
  }
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

/**
 * The call that is about to run, as text a judge can read.
 *
 * Before a call is the only moment when some mistakes are still cheap. A call
 * that names a field, argument or path that was assumed rather than read is
 * already wrong when it is submitted, and afterwards the only thing left to do
 * is describe what went wrong. So the pending call is put in front of the
 * judge alongside what the turn has actually looked at, which is exactly the
 * comparison that decides whether the name came from somewhere real.
 *
 * Long values are cut. The question is which names are being used, and a
 * judge reading a whole file body to answer that is being handed noise.
 */
const ALWAYS_JUDGE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'apply_patch'])
const SHELL_TOOLS = new Set(['Bash', 'exec_command'])
const COORDINATION_TOOLS = new Set([
  'send_message_to_thread',
  'mcp__codex_app__send_message_to_thread',
  'functions.exec',
  'exec',
])

/** Return the native tool call from the Codex/Claude hook event without
 * assuming that the provider uses the Claude-only Bash/Edit vocabulary. */
export function normalizeToolEvent(event) {
  if (!event || typeof event !== 'object') return null
  const name = event.tool_name ?? event.toolName ?? event.name ?? event.tool
  const input = event.tool_input ?? event.toolInput ?? event.input ?? event.arguments
  if (typeof name !== 'string' || !input || typeof input !== 'object') return null
  return {name, input}
}

function eventText(input) {
  return Object.entries(input).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return `${key}: ${text ?? ''}`
  }).join('\n')
}

function isClearlyReadOnlyCommand(input) {
  const shellText = typeof input.cmd === 'string' ? input.cmd : typeof input.command === 'string' ? input.command : ''
  if (!shellText.trim()) return false
  const inspection = /^(?:\s*cd\s+[^;&|]+\s*(?:&&\s*)?)?(?:pwd|ls|tree|find|rg|grep|cat|head|tail|sed|awk|stat|file|wc|which|ps|git\s+(?:status|diff|log|show|rev-parse|branch|remote|grep)|node\s+--check|python3?\s+-m\s+json\.tool)\b/i
  return inspection.test(shellText.trim()) && !/(?:&&|\|\||;|\||>>?|\$\(|\b(?:touch|mkdir|rm|mv|cp|install|launchctl|open|curl|wget|npm|pnpm|cargo|flyctl|git\s+(?:add|commit|push|checkout|reset|restore))\b)/i.test(shellText)
}

// Native exec tools carry both reads and mutations under one tool name. Keep
// cheap inspection commands out of the model call, and judge only commands
// with an explicit write/build/deploy/send shape. The hook remains a judgement
// of consequential calls rather than a poll on every tool invocation.
export function isJudgedMutation(name, input) {
  if (ALWAYS_JUDGE_TOOLS.has(name)) return true
  const text = eventText(input)
  if (SHELL_TOOLS.has(name)) {
    if (isClearlyReadOnlyCommand(input)) return false
    return true
  }
  if (COORDINATION_TOOLS.has(name)) {
    if (name === 'functions.exec' || name === 'exec') {
      const code = Object.values(input).filter(value => typeof value === 'string').join('\n')
      // `functions.exec` often wraps a read-only exec_command. Inspect its
      // apparent shell text and judge only if it contains a concrete mutation.
      if (/exec_command\s*\(/.test(code)) {
        return /(?:git\s+(?:add|commit|push|reset|restore|checkout)|(?:sudo\s+)?(?:rm|mv|cp|mkdir|touch|install|launchctl|open)\b|npm\s+(?:install|publish)|pnpm\s+(?:install|publish)|cargo\s+(?:install|publish)|\bdeploy\b|send_message_to_thread)/i.test(code)
      }
      return /(?:apply_patch|send_message_to_thread|writeFile|appendFile|rename|unlink|rmSync|writeFileSync|fetch\s*\(|\.click\s*\()/i.test(code)
    }
    return true
  }
  return false
}

export function readPendingCall(stdin, limitCharacters = 1200) {
  const normalized = normalizeToolEvent(stdin)
  if (!normalized) return null
  const {name, input} = normalized
  if (!isJudgedMutation(name, input)) return null

  const whole = eventText(input)

  // Never judge a call that is running this package.
  //
  // Correcting a wrong verdict means handing the correction tool the exact
  // text that was wrongly flagged. Judged like anything else, that call gets
  // flagged for containing it, and the flag is what stops the correction from
  // being recorded. The false positive then cannot be fixed by the mechanism
  // built to fix it, and it gets louder every attempt because each blocked try
  // is another occurrence in memory. That happened twice within a minute of
  // this check going live.
  //
  // Worked out from where this file sits rather than from a list of tool
  // names, so it stays true if anything here is renamed or added to.
  const ownDirectory = dirname(fileURLToPath(import.meta.url))
  if (whole.includes(ownDirectory)) return null

  const parts = []
  for (const [field, value] of Object.entries(input)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (!text) continue
    parts.push(`${field}: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`)
  }
  if (parts.length === 0) return null
  return `ABOUT TO RUN ${name}:\n${parts.join('\n')}`.slice(0, limitCharacters)
}

/**
 * The turn as the judge should see it: what was asked, and what the agent said
 * it did. Tool output is deliberately left out. The question is whether the
 * account holds up, and these models are documented to get WORSE when the
 * state is padded with detail that has nothing to do with the decision. A tool
 * that exists to handle bloated context should not hand over a bloated one.
 */
export function readTurn(transcriptPath, limitCharacters) {
  let lines = []
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return null
  }
  // Walk BACKWARDS until there is enough to judge, rather than taking a fixed
  // number of lines. A transcript is mostly tool rows, so a fixed window of
  // lines can contain almost no speech at all: the first version of this took
  // the last sixty lines and handed the judge 450 characters of a very long
  // conversation, which is a confident answer about nothing.
  const said = []
  let gathered = 0
  for (let index = lines.length - 1; index >= 0 && gathered < limitCharacters; index -= 1) {
    let row = null
    try {
      row = JSON.parse(lines[index])
    } catch {
      continue
    }
    const message = row?.message ?? (row?.type === 'response_item' && row?.payload?.type === 'message' ? row.payload : null)
    const role = message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = message.content
    const text = Array.isArray(content)
      ? content.filter(part => ['text', 'input_text', 'output_text'].includes(part?.type)).map(part => part.text).join('\n')
      : typeof content === 'string'
        ? content
        : ''
    if (!text.trim()) continue
    said.push(`${role === 'user' ? 'ASKED' : 'ANSWERED'}: ${text.trim()}`)
    gathered += text.length
  }
  if (said.length === 0) return null
  // Gathered newest first, so put it back in the order it happened.
  const whole = said.reverse().join('\n\n')
  // Trimmed from the FRONT, because the end of the turn is the part being
  // judged and the beginning is the part that can be spared.
  return whole.length <= limitCharacters ? whole : whole.slice(whole.length - limitCharacters)
}

/** Codex hook events can omit transcript_path while providing a session id. */
export function findCodexTranscript(sessionId, codexRoot = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(sessionId)) return null
  const root = join(codexRoot, 'sessions')
  let selected = null
  let newest = -1
  try {
    for (const year of readdirSync(root, {withFileTypes: true})) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue
      const yearPath = join(root, year.name)
      for (const month of readdirSync(yearPath, {withFileTypes: true})) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue
        const monthPath = join(yearPath, month.name)
        for (const day of readdirSync(monthPath, {withFileTypes: true})) {
          if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue
          const dayPath = join(monthPath, day.name)
          for (const file of readdirSync(dayPath, {withFileTypes: true})) {
            if (!file.isFile() || !file.name.startsWith('rollout-') || !file.name.includes(sessionId) || !file.name.endsWith('.jsonl')) continue
            const path = join(dayPath, file.name)
            const modified = statSync(path).mtimeMs
            if (modified > newest) { selected = path; newest = modified }
          }
        }
      }
    }
  } catch { return null }
  return selected
}

function recorder(logPath) {
  return row => {
    if (!logPath) return
    try {
      mkdirSync(dirname(logPath), {recursive: true})
      appendFileSync(logPath, `${JSON.stringify(row)}\n`)
    } catch {
      // A log that cannot be written must not take the session down with it.
    }
  }
}

/**
 * Whether the judge has gone quiet: how many rows since the last real verdict,
 * when that verdict was, and the latest reason given instead. Read from the end
 * of the log only, since the log grows by a row every turn.
 *
 * The judge fails open by design, so a dead judge looks exactly like a turn
 * with nothing to flag. On 2026-09-26 it gave no verdict for eleven hours and
 * nobody could tell. Saying so is the only thing that makes failing open safe.
 */
export function howQuietTheJudgeIs(logPath, readBytes = 512 * 1024) {
  let text = ''
  let cut = false
  try {
    // Only the tail is read: the log gains a row per turn and grows without end.
    const size = statSync(logPath).size
    cut = size > readBytes
    const length = Math.min(size, readBytes)
    const buffer = Buffer.alloc(length)
    const handle = openSync(logPath, 'r')
    try { readSync(handle, buffer, 0, length, size - length) } finally { closeSync(handle) }
    text = buffer.toString('utf8')
  } catch {
    return null
  }
  // A read that starts mid-file starts mid-row, so that first piece is dropped.
  const rows = text.split('\n').filter(Boolean).slice(cut ? 1 : 0).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  let since = 0
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].answered_by) return {rows_without_a_verdict: since, last_verdict_at: rows[index].asked_at ?? rows[index].at ?? null, latest_reason: rows.at(-1)?.skipped ?? null}
    since += 1
  }
  return {rows_without_a_verdict: since, last_verdict_at: null, latest_reason: rows.at(-1)?.skipped ?? null, at_least: true}
}

function sayWhenTheJudgeIsDead(logPath, rule) {
  if (!logPath || !rule) return
  const quiet = howQuietTheJudgeIs(logPath)
  if (!quiet || quiet.rows_without_a_verdict < (rule.after_rows_without_a_verdict ?? 200)) return
  const saidAt = `${logPath}.quiet-said`
  try {
    if (Date.now() - statSync(saidAt).mtimeMs < (rule.say_again_after_minutes ?? 30) * 60000) return
  } catch {}
  try { writeFileSync(saidAt, new Date().toISOString()) } catch {}
  const since = quiet.last_verdict_at ? `since ${quiet.last_verdict_at}` : 'in the whole log kept'
  const reason = quiet.latest_reason ? ` Latest reason: ${String(quiet.latest_reason).slice(0, 300)}` : ''
  process.stdout.write(JSON.stringify({systemMessage: `The turn judge has given no verdict ${since} (${quiet.at_least ? 'at least ' : ''}${quiet.rows_without_a_verdict} checks without one), so nothing is being checked.${reason}`}) + '\n')
}

export async function main(argv, stdin) {
  const {
    rubrics: rubricsPath,
    log: logPath,
    transcript,
    when,
    minNewCharacters,
    sinceFile,
    memory: memoryPath,
    remember: rememberPath,
  } = readArguments(argv)
  // Which session this was. Needed to tell one turn repeating itself from the
  // same mistake showing up independently in several places, which are very
  // different problems wearing the same count.
  const session = stdin?.session_id ?? null
  const record = recorder(logPath)
  if (!rubricsPath) {
    record({at: new Date().toISOString(), skipped: 'no --rubrics given'})
    return 0
  }

  const transcriptPath = transcript || stdin?.transcript_path || stdin?.transcriptPath
    || findCodexTranscript(session || process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID)
  const pending = when === 'before-a-call' ? readPendingCall(stdin) : null
  if (!transcriptPath) {
    const reason = 'no transcript to read'
    record({at: new Date().toISOString(), skipped: reason, tool: pending ? normalizeToolEvent(stdin)?.name : undefined})
    if (pending) {
      process.stderr.write(`Cannot judge consequential call: ${reason}. The call was blocked because its conversation context is unavailable.\n`)
      return 2
    }
    return 0
  }

  if (pending && !readTurn(transcriptPath, 1)) {
    const reason = 'transcript is missing, unreadable, or contains no user/assistant text'
    record({at: new Date().toISOString(), skipped: reason, tool: normalizeToolEvent(stdin)?.name})
    process.stderr.write(`Cannot judge consequential call: ${reason}. The call was blocked because its conversation context is unavailable.\n`)
    return 2
  }

  // Mid-turn, skip unless the turn has grown. A check that re-reads the same
  // words and reaches the same verdict is a paid call for an answer already
  // known, and the noise is what makes a real one get ignored.
  //
  // The mark is kept per transcript, never as one number. Several sessions run
  // on this machine at once and they share this file. A single number means the
  // longest transcript sets it for everyone, every shorter one then measures
  // negative growth, and the check silently never runs again. That failure is
  // invisible precisely because it fails quiet: no error, no verdict, and a
  // hook that looks registered and healthy.
  if (minNewCharacters > 0 && sinceFile) {
    let marks = {}
    try { marks = JSON.parse(readFileSync(sinceFile, 'utf8')) } catch {}
    if (typeof marks !== 'object' || marks === null) marks = {}
    const before = Number(marks[transcriptPath]) || 0
    let now = 0
    try { now = readFileSync(transcriptPath, 'utf8').length } catch {}
    if (now - before < minNewCharacters) return 0
    marks[transcriptPath] = now
    try { mkdirSync(dirname(sinceFile), {recursive: true}); writeFileSync(sinceFile, JSON.stringify(marks)) } catch {}
  }

  let settings
  try {
    settings = JSON.parse(readFileSync(rubricsPath, 'utf8'))
  } catch (error) {
    record({at: new Date().toISOString(), skipped: `rubrics unreadable: ${error.message}`})
    return 0
  }

  if (when === 'ending') sayWhenTheJudgeIsDead(logPath, settings.when_the_judge_goes_quiet)

  // A provider is a DATA row: which adapter, and where to reach it.
  const asking = await whoCanBeAsked(settings)
  // Anything slow (starting a declared server, calibrating) happens in a
  // separate run, started here when this turn finds it has not happened.
  const getReady = () => rememberPath && startInTheBackground({rubrics: rubricsPath, remember: rememberPath})
  if (asking.length === 0) {
    record({at: new Date().toISOString(), skipped: 'nothing available to ask', getting_ready: Boolean(getReady())})
    return 0
  }

  const ask = args => asking.find(one => one.candidate.name === args.candidate.name).ask(args)
  const candidates = asking.map(one => one.candidate)

  const recall = rememberedIn(rememberPath)
  const memory = memoryPath ? readMemory(memoryPath) : null
  let memoryChanged = false

  const raised = []
  const forNow = (settings.rubrics ?? []).filter(one => (one.ask_when ?? "ending") === when || one.ask_when === "always")
  if (when === 'before-a-call' && !pending) return 0

  for (const rubric of forNow) {
    const said = readTurn(transcriptPath, rubric.reads_characters ?? 24000)
    // Before a call, the call itself is the thing being judged and the turn is
    // only there to show what has and has not been looked at. It goes last so
    // it is the nearest thing to the question.
    const turn = pending ? `${said ?? ''}\n\n${pending}`.trim() : said
    if (!turn) continue
    try {
      // Only a judge calibration already chose. Calibrating here cannot fit the deadline.
      const verdict = await judge({rubric, content: turn, candidates, ask, passes: 1, remember: recall, calibrate: !recall})
      // The end of the turn is kept, not the count of its characters. A log
      // that records only how much was read cannot tell anyone later whether
      // the same mistake is being made again, which is what makes a check
      // repeat itself forever. The tail is where the offending part is.
      const excerpt = turn.slice(-KEEP_CHARACTERS)
      record({
        ...verdict,
        session,
        asked_about: {...verdict.asked_about, question: undefined, excerpt},
      })
      // Remember on the ANSWER, speak on the BAND. These are two different
      // decisions and folding them together loses most of the history.
      //
      // Measured: the same text judged four times answered true every time and
      // landed at 0.6464, 0.85, 0.6464, 0.6464, flickering across the line that
      // decides whether to interrupt. Remembering only the loud one recorded
      // one occurrence out of four. A counter meant to say "this is the sixth
      // time" would then never get near six, and the escalation that is the
      // whole point of keeping memory could not fire.
      //
      // Whether the mistake happened is the answer. How sure the classifier is
      // only decides whether it is worth stopping the turn over.
      let shape = null
      if (memory && verdict.answer === true) {
        const shapeId = await whichShape({excerpt, shapes: shapesFor(memory, rubric.id), candidates, ask})
        shape = noteIt({memory, rubricId: rubric.id, excerpt, shapeId, session, at: new Date().toISOString()})
        memoryChanged = true
      }
      if (verdict.band === 'raise-it' && verdict.answer === true) {
        raised.push(shape ? whatToSay(rubric.say, shape) : rubric.say)
      }
    } catch (error) {
      // Not calibrated yet, or the chosen judge's server is not answering: both
      // are fixed by the separate run, never by waiting here.
      const unreachable = /ECONNREFUSED|fetch failed|TimeoutError|timed out/i.test(`${error?.message} ${error?.cause?.code ?? ''}`)
      const gettingReady = error instanceof NotCalibratedYet || unreachable ? Boolean(getReady()) : undefined
      record({
        at: new Date().toISOString(),
        rubric_id: rubric.id,
        skipped: error instanceof VerdictRefused ? `refused: ${error.message}` : `failed: ${error.message}`,
        ...(gettingReady === undefined ? {} : {getting_ready: gettingReady}),
      })
    }
  }

  if (memory && memoryChanged) writeMemory(memoryPath, memory)

  if (raised.length === 0) return 0
  process.stderr.write(
    `Before this turn ends, something about it does not hold up:\n\n${raised.map(one => `  ${one}`).join('\n')}\n\n` +
      'Either do the remaining work now, or say exactly what stopped you: the file, the field, the refused ' +
      'command, the missing value.\n',
  )
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Failing open includes failing open on TIME. No request below carries its
  // own limit, and when every fast classifier is unreachable the fallback is a
  // local server that may first load a 30 GB model. The harness waits for this
  // process before it ends the turn, so without a deadline one slow server made
  // a one-word Codex reply take 610 s (2026-09-25). Keep this under the
  // smallest hook timeout that runs the judge.
  const argv = process.argv.slice(2)
  const flag = name => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1] }
  const deadlineSeconds = Number(flag('--deadline-seconds') ?? 5)
  setTimeout(() => {
    recorder(flag('--log'))({at: new Date().toISOString(), skipped: `no verdict within ${deadlineSeconds} s`})
    process.exit(0)
  }, deadlineSeconds * 1000)
  main(argv, readStdin()).then(
    code => process.exit(code),
    // Failing open is the whole design. A broken judge ends the turn quietly.
    () => process.exit(0),
  )
}
