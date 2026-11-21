// tools/export-documents-to-files/do-work/export-a-book.mjs
//
// tool:export-a-markdown-book-to-word. The book's settings row (record:setting:export-documents-to-files~piece~<book_id>) comes in the request as
// settings_record, the record itself as the person's AI read it, and is read through tools/settings; it reads no row for
// it. It runs the book's checks (the branch of list:checks the settings name, through tools/check-against-a-persons-rules-and-verdicts
// in branch mode, with the rows the request carries as `records`) on the exact
// manuscript bytes, and only when they pass hands the settings and that receipt to the Word exporter
// (export_markdown_book_to_word.py), whose writing gate also checks the writing profile and source spans
// (tools/pin-files-by-content) and the captured book-voice run (tools/train-and-evaluate-a-writing-voice-classifier).
//
// On the person's computer, from the root of the Workshop checkout:
//   node tools/export-documents-to-files/do-work/export-a-book.mjs < REQUEST.json
// REQUEST: { book_id, settings_record, records?, manuscript?, template?, output?, page_map?, answers?, purpose?, job_file?, python? }
// records: the rows the person's AI read from their own store for the book's checks branch (its check rows, list rows and the branch rows), each { id, type, value }.
// Answer: exported, blocked, or an explicitly admitted private_layout_proof with delivery_eligible=false.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { checkABranch } from '../../check-against-a-persons-rules-and-verdicts/do-work/check-a-branch.mjs';
import { recordsHandedIn } from '../../check-against-a-persons-rules-and-verdicts/do-work/records-in-hand.mjs';
import { distinctUnits, wordsOfMarkdown } from '../../check-against-a-persons-rules-and-verdicts/do-work/read-words.mjs';

export const TOOL_FOLDER = 'export-documents-to-files';
export const TOOL_ID = 'tool:export-a-markdown-book-to-word';
const here = fileURLToPath(new URL('.', import.meta.url));
const SETTINGS_READER = new URL('../../settings/read-data/settings.mjs', import.meta.url);
const EXPORTER = join(here, 'export_markdown_book_to_word.py');

/** The book's settings, from the settings row the request carries, read through the one shared reader. `settings` in the request wins only in tests. */
export async function settingsOfBook(input) {
  if (input.settings !== undefined) return input.settings;
  if (typeof input.book_id !== 'string' || !input.book_id) throw new Error('book_id names the book whose settings row to read.');
  if (!existsSync(fileURLToPath(SETTINGS_READER))) throw new Error('tools/settings is not in this checkout; the settings row cannot be read.');
  const { setting, settingId, isSettingId } = await import(SETTINGS_READER.href);
  const given = input.settings_record;
  const id = settingId(TOOL_FOLDER, 'piece', input.book_id);
  if (isSettingId(given)) throw new Error(`settings_record ${given} is a row's id: give the row itself, { id, type, value }, as your AI read it from your settings table.`);
  if (given === null || typeof given !== 'object') throw new Error(`No settings row given: the book has no export settings, so nothing is exported. Give ${id} as settings_record, the record itself.`);
  const settings = setting(given, { folder: TOOL_FOLDER, scopes: [['piece', input.book_id]], tool: TOOL_ID });
  if (settings === null) throw new Error(`${given.id} is not the settings row of piece ${input.book_id}.`);
  return settings;
}

/** The book's checks on these exact bytes: the branch mode's answer, as the receipt the writing gate binds. */
export async function bookChecks(records, { branch, bytes, answers = {}, reading = {} }) {
  const read = wordsOfMarkdown(bytes.toString('utf8'), 'manuscript', reading);
  const units = distinctUnits(read.units);
  const document_blake3 = makeHashCodeHexFromBytes(bytes).split(':')[1];
  if (!units.length) return { branch, status: 'no-units', passed: false, document_blake3, issues: read.issues };
  const answer = await checkABranch({ branch, units, answers }, records);
  return { branch, lineage: answer.lineage, status: answer.status, passed: answer.passed === true && answer.status === 'passed',
    document_blake3, rows_used: answer.rows_used, lines: answer.lines, questions: answer.questions,
    questions_page: answer.questions_page, issues: read.issues };
}

export async function exportABook(input) {
  const settings = await settingsOfBook(input);
  if (!settings || typeof settings !== 'object') return { status: 'blocked', reason: 'The settings row holds no settings object.' };
  const manuscript = input.manuscript ?? settings.manuscript;
  if (typeof manuscript !== 'string') return { status: 'blocked', reason: 'Name the manuscript (manuscript in the request or the settings).' };
  const purpose = input.purpose ?? 'final_delivery';
  if (!['final_delivery', 'private_layout_proof'].includes(purpose)) return { status: 'blocked', reason: 'Unknown export purpose.' };
  const privateProof = purpose === 'private_layout_proof';
  if (privateProof && (settings.role !== 'current_prose' || !settings.export_purposes?.private_layout_proof ||
      typeof input.job_file !== 'string' || input.output || input.template || input.page_map)) {
    return { status: 'blocked', reason: 'Private layout proof requires explicit settings admission, job_file and policy-owned output.' };
  }
  if (!privateProof && input.job_file) return { status: 'blocked', reason: 'job_file belongs only to private_layout_proof.' };
  const bytes = privateProof ? null : readFileSync(manuscript);
  let checks = null;
  if (settings.role === 'current_prose' && !privateProof) {
    if (typeof settings.checks_branch !== 'string') return { status: 'blocked', reason: 'Current prose needs checks_branch in its settings: the branch of list:checks for this book.' };
    if (input.records === undefined) return { status: 'blocked', reason: 'The book\'s checks read the rows of its checks branch: give them as records, read by your AI from your own store. Nothing is checked against no rows.' };
    checks = await bookChecks(recordsHandedIn(input.records), { branch: settings.checks_branch, bytes, answers: input.answers ?? {}, reading: settings.checks_reading ?? {} });
    if (!checks.passed) return { status: 'blocked', reason: `The book's checks answered ${checks.status}; no DOCX was created.`, checks };
  }
  const work = mkdtempSync(join(tmpdir(), 'export-a-book-'));
  try {
    writeFileSync(join(work, 'settings.json'), JSON.stringify(settings));
    const argv = [EXPORTER, manuscript, '--settings', join(work, 'settings.json')];
    if (privateProof) argv.push('--purpose', purpose, '--job-file', input.job_file);
    if (checks) { writeFileSync(join(work, 'checks.json'), JSON.stringify(checks)); argv.push('--checks-receipt', join(work, 'checks.json')); }
    const template = privateProof ? undefined : input.template ?? settings.template;
    const output = privateProof ? undefined : input.output ?? (settings.output_folder && input.book_id ? join(settings.output_folder, `${input.book_id}.docx`) : undefined);
    if (template) argv.push('--template', template);
    if (output) argv.push('--output', output);
    if (input.page_map) argv.push('--page-map', input.page_map);
    const run = spawnSync(input.python ?? 'python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) return { status: 'blocked', reason: (run.stderr.trim().split('\n').at(-1) ?? 'the exporter failed').replace(/^.*?error: /u, ''), checks };
    const answer = JSON.parse(run.stdout.trim().split('\n').at(-1));
    if (privateProof) {
      if (answer.status !== 'private_layout_proof' || answer.delivery_eligible !== false ||
          answer.gate?.schema !== 'private-layout-proof-result-v1' ||
          answer.gate?.purpose !== purpose || answer.gate?.delivery_eligible !== false ||
          answer.gate?.voice_qualification !== 'not_established' || answer.gate?.unfinished_label_readback !== true ||
          typeof answer.written !== 'string' || answer.gate?.artifact?.path !== answer.written) {
        return { status: 'blocked', reason: 'The exporter did not return a private non-delivery receipt.', checks };
      }
      return { ...answer, checks };
    }
    return { status: 'exported', written: answer.written, headings: answer.headings, tables: answer.tables, gate: answer.gate, checks };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// One JSON request on standard input, one { result } JSON line on standard output.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { text } = await import('node:stream/consumers');
  try {
    console.log(JSON.stringify({ result: await exportABook(JSON.parse((await text(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
