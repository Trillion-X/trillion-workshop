// tools/print-here/read-data/print-here.mjs
//
// PURPOSE
//   Prints a file from the person's files on a printer their Mac already has (`print`), and says which printers it
//   has (`printers`). Runs on the person's own Mac as a `computer` row holding the print-system capability; `print`
//   also reads the file through the local door with the run's own capability (tools/records-door `door.files`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: the print commands, options and words are DATA (read-data/print-here.json); nothing here names a printer,
//      a paper size or a brand.
//   2. The file's bytes go from the person's files to the print system on standard input; nothing is written to a
//      folder, so no copy is left behind.
//   3. A printer the Mac does not have is refused in words with the printers it does have; nothing is guessed: with
//      no printer named and no default, a Mac with more than one printer asks which.
//   4. One run prints once: the engine keeps each run by its request key, so a retry answers the first run.
//
// SECURITY
//   The print command is run with an argument list, never through a shell, so no file name or title can run anything.
//
// USAGE
//   node /opt/records-door/do-work/run-an-export.mjs /opt/print-here/read-data/print-here.mjs printers|print
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

/** Every byte of one file of the person's files, read through the door in `read_bytes` steps. */
export async function readWhole(call, settings, file) {
  const { find, read } = settings.files;
  const found = await call(find, { name_or_identity: file });
  const title = String(found.names?.[0] ?? found.name ?? file).split('/').pop();
  const parts = [];
  let offset = 0;
  for (;;) {
    const piece = await call(read, { name_or_identity: file, offset, length: settings.read_bytes });
    if (piece.byte_length > settings.most_bytes) return { title, size: piece.byte_length, bytes: null };
    parts.push(Buffer.from(piece.content ?? '', piece.encoding === 'base64' ? 'base64' : 'utf8'));
    offset += piece.bytes_returned;
    if (!piece.bytes_returned || offset >= piece.byte_length) return { title, size: offset, bytes: Buffer.concat(parts) };
  }
}

/**
 * deps { settings?, list?: () → lpstat text, send?: ({ command, args, bytes }) → { job }, read?: (file) → { bytes, title, size } }
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
    async print(input, read) {
      if (!input?.file) return { printed: false, said: w.no_file };
      const { printers, default: fallback } = printersFrom(await list());
      if (!printers.length) return { printed: false, said: w.no_printer };
      const printer = input.printer ?? fallback ?? (printers.length === 1 ? printers[0].name : null);
      if (!printer) return { printed: false, said: fill(w.which_printer, { printers: printers.map(row => row.name).join(', ') }) };
      if (!printers.some(row => row.name === printer)) return { printed: false, said: fill(w.unknown_printer, { printer, printers: printers.map(row => row.name).join(', ') }) };
      let file;
      try { file = await read(input.file); } catch (error) { return { printed: false, said: fill(w.not_read, { file: input.file, error: error.message }) }; }
      const title = input.title ?? file.title;
      if (!file.bytes) return { printed: false, said: fill(w.too_big, { title, mb: Math.round(file.size / 1e6), most: Math.round(settings.most_bytes / 1e6) }) };
      const copies = Math.max(1, Math.min(Number(input.copies) || 1, 100));
      const { command, args } = printArguments(settings, { ...input, printer, copies, title });
      const { job } = await send({ command, args, bytes: file.bytes });
      return { printed: true, printer, job, copies, said: fill(w.printed, { title, printer, copies }) };
    },
  };
}

/** `tool:printers`: the printers this Mac has and its default. */
export async function printers() {
  return makePrintTools().printers();
}

/** `tool:print`: one file of the person's files on one printer, read through the run's door. */
export async function print(input, { door }) {
  const settings = printSettings();
  // Reads change nothing, so each door call keeps the client's own request key.
  const call = (method, request) => door.files(method, request);
  return makePrintTools({ settings }).print(input, file => readWhole(call, settings, file));
}
