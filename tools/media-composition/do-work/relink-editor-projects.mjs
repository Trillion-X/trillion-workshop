/**
 * file: tools/media-composition/do-work/relink-editor-projects.mjs
 *
 * PURPOSE: On the person's own computer, point their video editors at clips that moved to a permanent place (for
 * example from a camera card to their Trillion files, which appear as a drive once that folder is connected):
 *   Premiere Pro     each project file that names a moved clip is rewritten to name its new place
 *   DaVinci Resolve  while it is running, clips in its open project are relinked through its own scripting API
 *                    (relink-in-resolve.py: MediaPoolItem.ReplaceClip), then the project is saved
 * Ported from the Mac app's premiere-relink.mjs and editor-relink.mjs. It runs where the editors are
 * (placement:caller-sandbox), never in a container, because the projects live on that computer.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Only the elements Premiere reads media locations from are changed (MEDIA_PATH_ELEMENTS); every other byte of the
 *    project is kept, and a project that names no moved clip is never written.
 * 2. A project some program has open, or that changed while it was read, is left alone and reported as waiting.
 * 3. The original project is kept beside the new one (`.<name>.before-relink-<time>`), so every change can be undone.
 * 4. Paths are inputs; nothing here knows a card, drive, camera, service or person.
 *
 * Usage: node relink-editor-projects.mjs --moves JSON [--projects JSON]
 *   moves     [{ "from": "<old full path>", "to": "<new full path>" }]; a folder moves every file under it
 *   projects  the Premiere project files to check; left out on a Mac, Spotlight finds every .prproj
 * Output (stdout, JSON): { projects: [{ file, state, paths_changed?, original_kept_at?, moves_waiting? }],
 *                          resolve: { state, project?, relinked, failed }, said }
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Each element Premiere reads a media location from, and how its value is written.
export const MEDIA_PATH_ELEMENTS = Object.freeze([
  Object.freeze({ element: 'FilePath', form: 'absolute' }),
  Object.freeze({ element: 'ActualMediaFilePath', form: 'absolute' }),
  Object.freeze({ element: 'RelativePath', form: 'relative-to-project' }),
]);
const RESOLVE_RELINK = fileURLToPath(new URL('./relink-in-resolve.py', import.meta.url));

const windowsPath = value => /^[A-Za-z]:[\\/]/.test(value);
const pathsFor = value => (windowsPath(value) ? path.win32 : path.posix);
const decodeXmlText = value => value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const encodeXmlText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A Premiere project's XML and whether it was gzipped (Premiere saves it gzipped). */
export function projectXml(bytes) {
  const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return { compressed, xml: (compressed ? zlib.gunzipSync(bytes) : bytes).toString('utf8') };
}
export const projectBytes = (xml, compressed) => (compressed ? zlib.gzipSync(Buffer.from(xml), { level: 9, mtime: 0 }) : Buffer.from(xml));

const run = (command, args, { input, okWithoutOutput = false } = {}) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    if (error && !(okWithoutOutput && !stdout)) reject(error); else resolve(String(stdout || ''));
  });
  if (input !== undefined) child.stdin.end(input);
});

export function checkedMoves(moves) {
  if (!Array.isArray(moves) || !moves.length) throw new Error('List the moved clips as [{ "from": "<old full path>", "to": "<new full path>" }].');
  return moves.map(move => {
    const from = String(move?.from ?? ''), to = String(move?.to ?? '');
    if (!pathsFor(from).isAbsolute(from) || !pathsFor(to).isAbsolute(to) || /[\x00-\x1f]/.test(from + to)) throw new Error('Each moved clip needs its old and new full location.');
    return { from: pathsFor(from).normalize(from).replace(/[\\/]+$/, ''), to: pathsFor(to).normalize(to).replace(/[\\/]+$/, '') };
  });
}

// Where a location now lives: the exact file, or a file inside a moved folder. Null when no move applies.
function movedLocation(location, moves) {
  for (const move of moves) {
    if (location === move.from) return { move, to: move.to };
    for (const separator of ['/', '\\']) if (location.startsWith(move.from + separator)) return { move, to: move.to + location.slice(move.from.length) };
  }
  return null;
}

/** One project's XML with every moved location rewritten: { xml, pathsChanged, referenced }. */
export function rewriteProjectXml(xml, moves, projectFile) {
  const paths = pathsFor(projectFile);
  const projectDir = paths.dirname(projectFile);
  const forms = new Map(MEDIA_PATH_ELEMENTS.map(entry => [entry.element, entry.form]));
  const pattern = new RegExp(`<(${MEDIA_PATH_ELEMENTS.map(entry => entry.element).join('|')})(\\s[^>]*)?>([^<]*)</\\1>`, 'g');
  const referenced = new Set();
  let pathsChanged = 0;
  const next = xml.replace(pattern, (whole, element, attributes = '', body) => {
    const stored = decodeXmlText(body);
    if (!stored) return whole;
    const relative = forms.get(element) === 'relative-to-project';
    const location = relative ? paths.resolve(projectDir, paths === path.posix ? stored.replaceAll('\\', '/') : stored) : stored;
    const found = movedLocation(location, moves);
    if (!found) return whole;
    referenced.add(found.move);
    const written = relative ? paths.relative(projectDir, found.to) : found.to;
    if (written === stored) return whole;
    pathsChanged += 1;
    return `<${element}${attributes}>${encodeXmlText(written)}</${element}>`;
  });
  return { xml: next, pathsChanged, referenced: [...referenced] };
}

// Spotlight's name search answers from its index at once; a leading-wildcard query scans every entry, so it is not used.
async function spotlightProjects() {
  if (process.platform !== 'darwin') throw new Error('Name the Premiere project files to check; only a Mac can find them all by itself.');
  return (await run('/usr/bin/mdfind', ['-name', '.prproj'])).split('\n').filter(line => path.isAbsolute(line) && line.toLowerCase().endsWith('.prproj'));
}

// lsof exits 1 with no output when nothing has the file open; a computer without lsof locks open files itself.
async function openByAnyProcess(file) {
  try { return (await run('lsof', ['-t', '--', file], { okWithoutOutput: true })).trim() !== ''; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function relinkPremiereProjects({ moves, projects, isOpen = openByAnyProcess, now = () => new Date() }) {
  const reports = [];
  for (const file of new Set(projects)) {
    let bytes;
    try { bytes = await fs.readFile(file); } catch { continue; }
    let source;
    try { source = projectXml(bytes); } catch { continue; }
    if (!source.xml.includes('<PremiereData')) continue;
    const result = rewriteProjectXml(source.xml, moves, file);
    if (!result.referenced.length || !result.pathsChanged) continue;
    const waiting = result.referenced.map(move => ({ from: move.from, to: move.to }));
    if (await isOpen(file)) { reports.push({ file, state: 'open', moves_waiting: waiting }); continue; }
    const paths = pathsFor(file);
    const stamp = now().toISOString().replace(/[^0-9]/g, '');
    const temporary = paths.join(paths.dirname(file), `.${paths.basename(file)}.relinking-${stamp}-${process.pid}`);
    const kept = paths.join(paths.dirname(file), `.${paths.basename(file)}.before-relink-${stamp}`);
    await fs.writeFile(temporary, projectBytes(result.xml, source.compressed), { flag: 'wx' });
    try {
      const current = await fs.readFile(file);
      if (!current.equals(bytes) || await isOpen(file)) {
        await fs.rm(temporary, { force: true });
        reports.push({ file, state: 'open', moves_waiting: waiting });
        continue;
      }
      await fs.rename(file, kept);
      await fs.rename(temporary, file);
      reports.push({ file, state: 'rewritten', paths_changed: result.pathsChanged, original_kept_at: kept });
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
  return reports;
}

/** Relinks clips in DaVinci Resolve's open project; { state: 'not-running' } when Resolve is closed. */
export async function relinkInRunningResolve({ moves, python = process.platform === 'win32' ? 'python' : 'python3' }) {
  let output = '';
  try { output = await run(python, [RESOLVE_RELINK], { input: JSON.stringify({ moves }) }); }
  catch { return { state: 'not-running', relinked: [], failed: [] }; }
  try { return { relinked: [], failed: [], ...JSON.parse(output.trim().split('\n').pop() || '{}') }; }
  catch { return { state: 'not-running', relinked: [], failed: [] }; }
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function summarize(projects, resolve) {
  const rewritten = projects.filter(report => report.state === 'rewritten').length;
  const open = projects.filter(report => report.state === 'open').length;
  const parts = [];
  if (rewritten) parts.push(`${count(rewritten, 'Premiere project now opens', 'Premiere projects now open')} the clips from their new place.`);
  if (open) parts.push(`${count(open, 'Premiere project is', 'Premiere projects are')} open; close ${open === 1 ? 'it' : 'them'} and run this again.`);
  if (resolve.state === 'running' && resolve.relinked.length) parts.push(`${count(resolve.relinked.length, 'clip', 'clips')} in DaVinci Resolve's open project now ${resolve.relinked.length === 1 ? 'opens' : 'open'} from the new place.`);
  if (resolve.failed?.length) parts.push(`DaVinci Resolve could not relink ${count(resolve.failed.length, 'clip', 'clips')}.`);
  return parts.length ? parts.join(' ') : 'No editor project named these clips.';
}

export async function relinkEditorProjects({ moves, projects, premiere = relinkPremiereProjects, resolve = relinkInRunningResolve, findProjects = spotlightProjects }) {
  const wanted = checkedMoves(moves);
  const projectReports = await premiere({ moves: wanted, projects: Array.isArray(projects) ? projects.map(String) : await findProjects() });
  const resolveReport = await resolve({ moves: wanted });
  return { projects: projectReports, resolve: resolveReport, said: summarize(projectReports, resolveReport) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);
  try {
    const parse = name => { try { return args.get(name) === undefined ? undefined : JSON.parse(args.get(name)); } catch { throw new Error(`--${name} is not JSON.`); } };
    process.stdout.write(`${JSON.stringify(await relinkEditorProjects({ moves: parse('moves'), projects: parse('projects') }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
