// tools/print-here/read-data/print-here.mjs
//
// PURPOSE
//   Prints a file from the person's files on a printer their Mac already has (`print`), and says which printers it
//   has (`printers`). Runs on the person's own Mac as a `computer` row holding the print-system capability. `print` is
//   given the file's bytes in `stored.files` (the caller reads them from the person's own files); it reads nothing itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: the print commands, options and words are DATA (read-data/print-here.json); nothing here names a printer,
//      a paper size or a brand.
//   2. The file's bytes go from the person's files to the print system on standard input; nothing is written to a
//      folder, so no copy is left behind.
//   3. A printer the Mac does not have is refused in words with the printers it does have; nothing is guessed: with
//      no printer named and no default, a Mac with more than one printer asks which.
//   4. One run prints once: the engine keeps each run by its request key, so a retry answers the first run. A host that
//      hands runs over by id (the Trillion Mac app's tool host: context.handoff_id and context.recordEffect) has the
//      job journaled before it is sent: a job already done answers its receipt, and one that may have started is
//      refused in words, never sent to the printer again.
//
// SECURITY
//   The print command is run with an argument list, never through a shell, so no file name or title can run anything.
//
// USAGE
//   node /opt/workflows/do-work/run-a-function.mjs /opt/print-here/read-data/print-here.mjs printers|print
//
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const printSettings = () => JSON.parse(readFileSync(new URL('./print-here.json', import.meta.url), 'utf8'));
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The printers lpstat's answer names and the default one. */
export function printersFrom(text) {
  const printers = [...String(text).matchAll(/^printer (\S+)\s+(.*)$/gm)].map(([, name, rest]) => ({ name, state: rest.split(/\.\s/)[0].replace(/^is /, '').trim() }));
  const fallback = String(text).match(/^system default destination: (\S+)/m)?.[1] ?? null;
  return { printers: printers.map(printer => ({ ...printer, default: printer.name === fallback })), default: fallback };
}

const run = (command, args) => new Promise((resolve, reject) => execFile(command, args, { timeout: 15_000 },
  (error, stdout, stderr) => (error && !stdout ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout)))));

/** The print command's argument list for one job, from the settings and the input. */
export function printArguments(settings, { printer, copies = 1, title, ...rest }) {
  const [command, ...template] = settings.commands.print;
  const args = template.map(part => fill(part, { printer, copies, title: title ?? settings.default_title }));
  for (const [field, option] of Object.entries(settings.options)) {
    const value = rest[field];
    if (value === undefined || value === null || value === false) continue;
    args.push('-o', value === true ? option : `${option}=${value}`);
  }
  return { command, args };
}

/** The file `file` names, from the bytes the caller handed in `stored.files` (text or { base64 }); none handed in is null. */
export function fileGiven({ file, stored }, settings) {
  const held = stored?.files?.[file];
  if (held === undefined) return null;
  const bytes = typeof held === 'string' ? Buffer.from(held, 'utf8') : Buffer.from(held.base64 ?? '', 'base64');
  return { title: String(file).split('/').pop(), size: bytes.length, bytes: bytes.length > settings.most_bytes ? null : bytes };
}

/**
 * deps { settings?, list?: () → lpstat text, send?: ({ command, args, bytes }) → { job } }
 * print(input, effects?: { handoff_id?, recordEffect? }) — the file is input.stored.files[input.file]
 */
export function makePrintTools(deps = {}) {
  const settings = deps.settings ?? printSettings();
  const list = deps.list ?? (async () => run(settings.commands.list[0], settings.commands.list.slice(1)).catch(() => ''));
  const send = deps.send ?? (({ command, args, bytes }) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve({ job: out.match(/request id is (\S+)/)?.[1] ?? out.trim() }) : reject(new Error(err.trim() || `the print command ended with ${code}`))));
    child.stdin.end(bytes);
  }));
  const w = settings.words;
  return {
    async printers() { return printersFrom(await list()); },
    async print(input, effects = {}) {
      if (!input?.file) return { printed: false, said: w.no_file };
      const { printers, default: fallback } = printersFrom(await list());
      if (!printers.length) return { printed: false, said: w.no_printer };
      const printer = input.printer ?? fallback ?? (printers.length === 1 ? printers[0].name : null);
      if (!printer) return { printed: false, said: fill(w.which_printer, { printers: printers.map(row => row.name).join(', ') }) };
      if (!printers.some(row => row.name === printer)) return { printed: false, said: fill(w.unknown_printer, { printer, printers: printers.map(row => row.name).join(', ') }) };
      const file = fileGiven(input, settings);
      if (!file) return { printed: false, said: fill(w.not_read, { file: input.file, error: w.not_handed_in }) };
      const title = input.title ?? file.title;
      if (!file.bytes) return { printed: false, said: fill(w.too_big, { title, mb: Math.round(file.size / 1e6), most: Math.round(settings.most_bytes / 1e6) }) };
      const copies = Math.max(1, Math.min(Number(input.copies) || 1, 100));
      const { command, args } = printArguments(settings, { ...input, printer, copies, title });
      const effect_id = effects.handoff_id && effects.recordEffect ? `print:${effects.handoff_id}` : null;
      if (effect_id) {
        const starting = await effects.recordEffect({ effect_id, state: 'starting', target: `${printer}: ${title}` });
        if (!starting.proceed) {
          if (starting.effect?.state === 'done' && starting.effect.receipt?.printed === true) return starting.effect.receipt;
          throw new Error(starting.note ?? w.may_have_started);
        }
        if (starting.repeated) throw new Error(w.may_have_started);
      }
      const { job } = await send({ command, args, bytes: file.bytes });
      const result = { printed: true, printer, job, copies, said: fill(w.printed, { title, printer, copies }) };
      if (effect_id) await effects.recordEffect({ effect_id, state: 'done', receipt: result });
      return result;
    },
  };
}

/** `tool:printers`: the printers this Mac has and its default. */
export async function printers() {
  return makePrintTools().printers();
}

/** `tool:print`: one file the caller handed in (`stored.files`) on one printer. */
export async function print(input, { handoff_id, recordEffect } = {}) {
  return makePrintTools().print(input, { handoff_id, recordEffect });
}
