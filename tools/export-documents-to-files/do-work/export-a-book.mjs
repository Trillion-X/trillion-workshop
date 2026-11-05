// tools/export-documents-to-files/do-work/export-a-book.mjs
//
// tool:export-a-markdown-book-to-word, the one entry with the person's records door. It reads the book's settings row
// (record:setting:export-documents-to-files~piece~<book_id>, through tools/settings), runs the book's checks (the branch
// of list:checks the settings name, through tools/check-against-a-persons-rules-and-verdicts in branch mode) on the exact
// manuscript bytes, and only when they pass hands the settings and that receipt to the Word exporter
// (export_markdown_book_to_word.py), whose writing gate also checks the writing profile and source spans
// (tools/pin-files-by-content) and the captured book-voice run (tools/train-and-evaluate-a-writing-voice-classifier).
//
// On the person's computer, with their door:
//   node tools/records-door/do-work/run-with-stdio-mcp.mjs CLIENT.json \
//     tools/export-documents-to-files/do-work/export-a-book.mjs exportABook REQUEST.json
// REQUEST: { book_id, settings_record?, manuscript?, template?, output?, page_map?, answers?, python? }
// Answer: { status: "exported", written, gate, checks } or { status: "blocked", reason, checks? }.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { checkABranch } from '../../check-against-a-persons-rules-and-verdicts/do-work/check-a-branch.mjs';
import { distinctUnits, wordsOfMarkdown } from '../../check-against-a-persons-rules-and-verdicts/do-work/read-words.mjs';

export const TOOL_FOLDER = 'export-documents-to-files';
export const TOOL_ID = 'tool:export-a-markdown-book-to-word';
const here = fileURLToPath(new URL('.', import.meta.url));
const SETTINGS_READER = new URL('../../settings/read-data/settings.mjs', import.meta.url);
const EXPORTER = join(here, 'export_markdown_book_to_word.py');

/** The book's settings, read through the one shared reader. `settings` in the request wins only in tests. */
export async function settingsOfBook(input, door) {
  if (input.settings !== undefined) return input.settings;
  if (typeof input.book_id !== 'string' || !input.book_id) throw new Error('book_id names the book whose settings row to read.');
  if (!existsSync(fileURLToPath(SETTINGS_READER))) throw new Error('tools/settings is not in this checkout; the settings row cannot be read.');
  const { setting, settingId } = await import(SETTINGS_READER.href);
  const id = input.settings_record ?? settingId(TOOL_FOLDER, 'piece', input.book_id);
  const value = await door.read('record:setting', id);
  if (value === null) throw new Error(`No settings row ${id}: the book has no export settings, so nothing is exported.`);
  const settings = setting({ id, type: 'record:setting', value }, { folder: TOOL_FOLDER, scopes: [['piece', input.book_id]], tool: TOOL_ID });
  if (settings === null) throw new Error(`${id} is not the settings row of piece ${input.book_id}.`);
  return settings;
}

/** The book's checks on these exact bytes: the branch mode's answer, as the receipt the writing gate binds. */
export async function bookChecks(door, { branch, bytes, answers = {}, reading = {} }) {
  const read = wordsOfMarkdown(bytes.toString('utf8'), 'manuscript', reading);
  const units = distinctUnits(read.units);
  const document_blake3 = makeHashCodeHexFromBytes(bytes).split(':')[1];
  if (!units.length) return { branch, status: 'no-units', passed: false, document_blake3, issues: read.issues };
  const answer = await checkABranch({ branch, units, answers }, door);
  return { branch, lineage: answer.lineage, status: answer.status, passed: answer.passed === true && answer.status === 'passed',
    document_blake3, rows_used: answer.rows_used, lines: answer.lines, questions: answer.questions,
    questions_page: answer.questions_page, issues: read.issues };
}

export async function exportABook(input, { door } = {}) {
  const settings = await settingsOfBook(input, door);
  if (!settings || typeof settings !== 'object') return { status: 'blocked', reason: 'The settings row holds no settings object.' };
  const manuscript = input.manuscript ?? settings.manuscript;
  if (typeof manuscript !== 'string') return { status: 'blocked', reason: 'Name the manuscript (manuscript in the request or the settings).' };
  const bytes = readFileSync(manuscript);
  let checks = null;
  if (settings.role === 'current_prose') {
    if (typeof settings.checks_branch !== 'string') return { status: 'blocked', reason: 'Current prose needs checks_branch in its settings: the branch of list:checks for this book.' };
    checks = await bookChecks(door, { branch: settings.checks_branch, bytes, answers: input.answers ?? {}, reading: settings.checks_reading ?? {} });
    if (!checks.passed) return { status: 'blocked', reason: `The book's checks answered ${checks.status}; no DOCX was created.`, checks };
  }
  const work = mkdtempSync(join(tmpdir(), 'export-a-book-'));
  try {
    writeFileSync(join(work, 'settings.json'), JSON.stringify(settings));
    const argv = [EXPORTER, manuscript, '--settings', join(work, 'settings.json')];
    if (checks) { writeFileSync(join(work, 'checks.json'), JSON.stringify(checks)); argv.push('--checks-receipt', join(work, 'checks.json')); }
    const template = input.template ?? settings.template;
    const output = input.output ?? (settings.output_folder && input.book_id ? join(settings.output_folder, `${input.book_id}.docx`) : undefined);
    if (template) argv.push('--template', template);
    if (output) argv.push('--output', output);
    if (input.page_map) argv.push('--page-map', input.page_map);
    const run = spawnSync(input.python ?? 'python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) return { status: 'blocked', reason: (run.stderr.trim().split('\n').at(-1) ?? 'the exporter failed').replace(/^.*?error: /u, ''), checks };
    const answer = JSON.parse(run.stdout.trim().split('\n').at(-1));
    return { status: 'exported', written: answer.written, headings: answer.headings, tables: answer.tables, gate: answer.gate, checks };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// One JSON request on standard input, one JSON answer on the last line, when there is no door (a comparison or
// historical reference with `settings` given, or a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { text } = await import('node:stream/consumers');
  try {
    console.log(JSON.stringify({ result: await exportABook(JSON.parse((await text(process.stdin)) || '{}'), {}) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
