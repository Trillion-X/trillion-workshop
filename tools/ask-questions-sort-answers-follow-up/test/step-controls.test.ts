// tools/ask-questions-sort-answers-follow-up/test/step-controls.test.ts
//
// The standing check that every question can be drawn: every type in data/question-types.json declares the control a page that
// asks one question at a time draws (or says why it has none), and every question row the Workshop ships or seeds (any JSON
// object under tools/ with a questionTypeId that is not a type row itself) names a type that is in that file and has a control.
// A type added without a control, or a question row of a type the file does not hold, fails here before a page shows a box the
// server would refuse. The types are kept in that one file: no other JSON under tools/ holds a type's row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { controlFor, controlOf, controlProblems, noControlWords, type QuestionRow, type TypeRow } from '../read-data/step-controls.ts';

const tools = join(import.meta.dirname, '..', '..');
const types = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'question-types.json'), 'utf8')).rows) as TypeRow[];

// Every JSON file under tools/, never node_modules or a built folder.
function jsonFiles(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) jsonFiles(path, found);
    else if (entry.name.endsWith('.json')) found.push(path);
  }
  return found;
}

// The question rows in a JSON value: objects that name a questionTypeId and are not a question type's own row.
function questionRows(value: unknown, where: string, found: QuestionRow[] = []): QuestionRow[] {
  if (Array.isArray(value)) value.forEach(item => questionRows(item, where, found));
  else if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (typeof row.questionTypeId === 'string' && row.kind !== 'question-type-capability') found.push({ where: `${where} ${String(row.questionId ?? '')}`.trim(), questionTypeId: row.questionTypeId });
    Object.values(row).forEach(item => questionRows(item, where, found));
  }
  return found;
}

// Whether a JSON value holds a question type's own row anywhere in it.
function holdsTypeRows(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsTypeRows);
  if (!value || typeof value !== 'object') return false;
  return (value as Record<string, unknown>).kind === 'question-type-capability' || Object.values(value).some(holdsTypeRows);
}

test('every question type declares its control in the one types file, and every question row the Workshop ships or seeds can be drawn', () => {
  const shipped: QuestionRow[] = [];
  const typeFiles: string[] = [];
  for (const file of jsonFiles(tools)) {
    let value: unknown;
    try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    questionRows(value, relative(tools, file), shipped);
    if (holdsTypeRows(value)) typeFiles.push(relative(tools, file));
  }
  assert.ok(shipped.length > 50, `found ${shipped.length} question rows`);
  assert.deepEqual(typeFiles, ['ask-questions-sort-answers-follow-up/data/question-types.json'], 'question types are kept in one file');
  assert.deepEqual(controlProblems(types, shipped), []);
});

test('each type draws what its server check takes: numbers and ratings a number box, picks their answers, a link a link box', () => {
  assert.deepEqual(controlFor('number'), { draw: 'number', step: 'any' });
  assert.deepEqual(controlFor('rating'), { draw: 'number', step: 1 });
  assert.deepEqual(controlFor('picks'), { draw: 'picks' });
  assert.deepEqual(controlFor('choice'), { draw: 'one' });
  assert.deepEqual(controlFor('link'), { draw: 'link' });
  assert.deepEqual(controlFor('text'), { draw: 'line' });
  assert.deepEqual(controlFor('long-text'), { draw: 'long' });
  assert.equal(controlFor('evidence-reference'), null);
  assert.equal(controlFor('made-up'), null);
});

test('a type with no control, a malformed control, or a row of a type the file does not hold is named', () => {
  const rows: TypeRow[] = [
    { questionTypeId: 'ok', control: { draw: 'line' } },
    { questionTypeId: 'silent' },
    { questionTypeId: 'odd', control: { draw: 'slider' } },
    { questionTypeId: 'stepless', control: { draw: 'number' } },
    { questionTypeId: 'reasoned', control: null, no_control_because: 'Captured elsewhere.' },
    { questionTypeId: 'both', control: { draw: 'line' }, no_control_because: 'Two answers.' },
  ];
  assert.throws(() => controlOf(rows[2]), /control\.draw must be one of/);
  assert.throws(() => controlOf(rows[3]), /names its step/);
  assert.deepEqual(controlProblems(rows, [{ where: 'form q1', questionTypeId: 'ok' }, { where: 'form q2', questionTypeId: 'reasoned' }, { where: 'form q3', questionTypeId: 'gone' }]), [
    'Question type silent declares no control and no no_control_because.',
    'Question type odd: control.draw must be one of line, long, number, link, picks, one.',
    'Question type stepless: a number control names its step, a positive number or "any".',
    'Question type both declares a control and no_control_because; say one.',
    `form q2: ${noControlWords('reasoned')}`,
    'form q3: type gone is not in question-types.json.',
  ]);
});
