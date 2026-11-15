// tools/record-a-job-shown-once/read-data/demonstration.mjs (moved from Trillion computer/demonstration.mjs)
//
// Purpose: "show me once". The person starts a short, bounded recording of what they do on this Mac (clicks, typing,
// shortcuts, with the app and the control each was in), and the recording comes back as a draft workflow an AI can keep
// with save_workflow after the person has looked at it. The AI writes nothing from this: it gets steps in words.
//
// Non-negotiable invariants
//   1. Bounded and visible to the person's own permission: seconds, events and steps are DATA (read-data/demonstration.json);
//      the recorder is listen only and needs the Mac's Input Monitoring; the stop key ends it early.
//   2. Typed text in a secure field is never recorded; the draft says a secret was typed and never contains it.
//   3. Consecutive typed characters in one app are one step; steps beyond most_steps are dropped and the draft says so.
//   4. Consent is the engine's: the row runs only while the person's grant of its capability to this tool stands; it is
//      never carried by a call. (The Mac app's own screen-permission file, Trillion computer/drive-the-screen.json, is not read here.)
//   5. Nothing here is kept: the recording is answered and forgotten.
//
// USAGE
//   node /opt/records-door/do-work/run-an-export.mjs /opt/record-a-job-shown-once/read-data/demonstration.mjs record
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const demonstrationSettings = () => JSON.parse(readFileSync(join(HERE, 'demonstration.json'), 'utf8'));
/** Runs a program with an argument list (never a shell), writes `input` to it and answers what it printed. */
const run = (program, args, { input, timeout }) => new Promise((resolve, reject) => {
  const child = execFile(program, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => (error && !stdout ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout))));
  child.stdin.end(input);
});
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (settings, key, values = {}, status = 403, reaction = 'ask_user') => Object.assign(new Error(fill(settings.words[key], values)), { status, reaction });
const targetOf = event => [event.title, event.description].find(Boolean) ? `"${[event.title, event.description].find(Boolean)}"${event.role ? ` (${event.role.replace(/^AX/, '').toLowerCase()})` : ''}` : (event.role ? `the ${event.role.replace(/^AX/, '').toLowerCase()}` : 'the control under the pointer');

/** The draft workflow for recorded events: consecutive typing folded, one step per action, words from the DATA templates. */
export function draftFromEvents(events, settings = demonstrationSettings(), { secrets = 0 } = {}) {
  const steps = [];
  const push = (kind, values) => steps.push(fill(settings.steps[kind], values));
  let typing = null;
  const flush = () => { if (typing) { push('type', { app: typing.app, text: typing.text.slice(0, settings.text_chars) }); typing = null; } };
  for (const event of events) {
    if (event.event === 'key' && typeof event.text === 'string' && event.text.length && !/[\u0000-\u001f]/.test(event.text)) {
      if (typing && typing.app === event.app) typing.text += event.text; else { flush(); typing = { app: event.app, text: event.text }; }
      continue;
    }
    flush();
    if (event.event === 'click' || event.event === 'right_click') push(event.event, { app: event.app, target: targetOf(event) });
    else if (event.event === 'chord') push('chord', { app: event.app, keys: [...(event.modifiers ?? []), event.text ?? `key ${event.key_code}`].join('+') });
    else if (event.event === 'key') push('key', { app: event.app, keys: event.text ? JSON.stringify(event.text) : `key ${event.key_code}` });
  }
  flush();
  if (secrets > 0) steps.push(fill(settings.steps.secret, { app: events.at(-1)?.app ?? 'the app' }));
  const kept = steps.slice(0, settings.most_steps);
  const id = `${settings.draft.id_prefix}${Date.now().toString(36)}`;
  return {
    id, label: settings.draft.label, job: settings.draft.job,
    steps: kept.map((words, index) => ({ id: `step-${index + 1}`, title: `Step ${index + 1}`, do: words, submit: settings.draft.submit })),
    dropped_steps: Math.max(0, steps.length - kept.length),
  };
}

/** The tool: tool:record-a-demonstration → { draft, events_seen, ended, said, secrets_skipped }. */
export function makeDemonstrationTools({ settings = demonstrationSettings(),
  record = request => run(settings.driver.program, [join(HERE, settings.driver.script)], { input: JSON.stringify(request), timeout: (request.seconds + 15) * 1000 }).then(value => JSON.parse(value)) } = {}) {
  return {
    async record(input = {}) {
      const seconds = Math.max(1, Math.min(settings.most_seconds, Number.isInteger(input.seconds) ? input.seconds : settings.default_seconds));
      const recorded = await record({ seconds, max_events: settings.most_events, stop_key_code: settings.stop_key_code });
      if (recorded.ended === 'needs_input_monitoring') throw refusal(settings, 'needs_input_monitoring', {}, 409);
      const events = recorded.events ?? [];
      if (!events.length && !recorded.secrets_skipped) throw refusal(settings, 'nothing', {}, 404, 'retry');
      return { draft: draftFromEvents(events, settings, { secrets: recorded.secrets_skipped ?? 0 }), events_seen: events.length, secrets_skipped: recorded.secrets_skipped ?? 0,
        ended: recorded.ended, said: settings.words.ended[recorded.ended] ?? '' };
    },
  };
}
export const demonstrationTools = makeDemonstrationTools();

/** The tool-table entry as a named function, for run-an-export.mjs. */
export const { record } = demonstrationTools;
