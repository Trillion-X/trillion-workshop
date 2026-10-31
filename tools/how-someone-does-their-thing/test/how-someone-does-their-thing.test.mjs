// tools/how-someone-does-their-thing: the brief, the profile record and the draft check, then each row's command as the
// container runs it. The old package was records only; its one test checked how its build workflow was wired, so these
// tests are written for the rules its records declared (derive from the subject's records only, refs not prose, a
// draft that carries the references to the profile). All data is made up.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { briefProfile, checkDraft, keepProfile } from '../read-data/profile.mjs';

const folder = join(import.meta.dirname, '..');
const base = { profile_ref: 'profile:bakery-voice', subject_ref: 'baker:1' };

test('the brief carries the subject records and the rules, and refuses a subject with nothing to derive from', () => {
  const brief = briefProfile({ ...base, subject_records: [{ text: 'Warm loaves, no fuss.' }], instruction: 'Keep it short.' });
  assert.equal(brief.subject_records.length, 1);
  assert.match(brief.rules.join(' '), /only the supplied subject records/);
  assert.equal(brief.rules.at(-1), 'Keep it short.');
  assert.throws(() => briefProfile({ ...base, subject_records: [] }), /at least one record/);
  assert.throws(() => briefProfile({ ...base, subject_records: ['text'] }), /must be an object/);
  assert.throws(() => briefProfile({ subject_ref: 'baker:1', subject_records: [{}] }), /profile_ref is required/);
  assert.throws(() => briefProfile({ profile_ref: 'p', subject_records: [{}] }), /subject_ref is required/);
});

test('a profile is kept with its refs and derived items, and an empty one is refused', () => {
  const profile = keepProfile({ ...base, derived_items: [{ kind: 'tone', value: 'warm', evidence: 'post:1' }], evaluator_refs: ['evaluator:tone'], validation_policy_ref: 'policy:fit' });
  assert.deepEqual(profile, {
    type: 'profile',
    id: 'profile:bakery-voice',
    subject_ref: 'baker:1',
    feature_schema_refs: [],
    evaluator_refs: ['evaluator:tone'],
    generator_refs: [],
    validation_policy_ref: 'policy:fit',
    derived_items: [{ kind: 'tone', value: 'warm', evidence: 'post:1' }],
  });
  assert.throws(() => keepProfile({ ...base, derived_items: [] }), /non-empty list/);
  assert.throws(() => keepProfile({ ...base }), /non-empty list/);
  const item = { kind: 'tone', value: 'warm', evidence: 'post:1' };
  assert.throws(() => keepProfile({ ...base, derived_items: [item], evaluator_refs: [''] }), /evaluator_refs must be a list of refs/);
  assert.throws(() => keepProfile({ ...base, derived_items: [item], generator_refs: 'g' }), /generator_refs must be a list/);
  assert.throws(() => keepProfile({ ...base, derived_items: [item], validation_policy_ref: ' ' }), /validation_policy_ref/);
});

test('the validation policy is one ref or the pair that names the gate and its spec, and nothing else', () => {
  const item = { kind: 'tone', value: 'warm', evidence: 'post:1' };
  const pair = { gate_target_ref: ' gate:evaluate ', gate_spec_ref: 'spec:profile-fit' };
  assert.deepEqual(keepProfile({ ...base, derived_items: [item], validation_policy_ref: pair }).validation_policy_ref, { gate_target_ref: 'gate:evaluate', gate_spec_ref: 'spec:profile-fit' });
  assert.equal('validation_policy_ref' in keepProfile({ ...base, derived_items: [item] }), false);
  for (const bad of [{ gate_target_ref: 'gate:evaluate' }, { gate_target_ref: 'g', gate_spec_ref: '' }, { gate_target_ref: 'g', gate_spec_ref: 's', extra: 1 }, [], 4, null]) {
    assert.throws(() => keepProfile({ ...base, derived_items: [item], validation_policy_ref: bad }), /validation_policy_ref must be/);
  }
});

test('a kept item shows what it is, states it and names the record that shows it, as the brief asked', () => {
  const item = { kind: 'tone', value: 'warm', evidence: 'post:1' };
  assert.throws(() => keepProfile({ ...base, derived_items: [item, { value: 'warm', evidence: 'post:1' }] }), /derived_items\[1\]\.kind/);
  assert.throws(() => keepProfile({ ...base, derived_items: [{ kind: 'tone', evidence: 'post:1' }] }), /derived_items\[0\]\.value/);
  assert.throws(() => keepProfile({ ...base, derived_items: [{ kind: 'tone', value: ' ', evidence: 'post:1' }] }), /\.value is required/);
  assert.throws(() => keepProfile({ ...base, derived_items: [{ kind: 'tone', value: 'warm' }] }), /\.evidence must be/);
  assert.throws(() => keepProfile({ ...base, derived_items: [{ kind: 'tone', value: 'warm', evidence: 3 }] }), /\.evidence must be/);
  assert.equal(keepProfile({ ...base, derived_items: [{ kind: 'count', value: 0, evidence: 'post:2' }] }).derived_items[0].value, 0);
});

test('a draft fits when some block carries each required reference, and names the field that fails', () => {
  const draft = { blocks: [{ text: 'Fresh today.' }, { profile_ref: 'profile:bakery-voice', conditioning_profile_ref: 'profile:bakery-voice' }] };
  const fits = checkDraft({ draft, required_ref_fields: ['profile_ref', 'conditioning_profile_ref'], profile_ref: 'profile:bakery-voice' });
  assert.equal(fits.fits, true);
  assert.deepEqual(fits.rules.map((rule) => rule.passed), [true, true]);
  const missing = checkDraft({ draft: { blocks: [{ profile_ref: 'profile:bakery-voice' }] }, required_ref_fields: ['profile_ref', 'conditioning_profile_ref'] });
  assert.equal(missing.fits, false);
  assert.deepEqual(missing.rules.map((rule) => rule.passed), [true, false]);
  assert.match(missing.rules[1].reason, /no block of the draft carries conditioning_profile_ref/);
});

test('a reference that names another profile fails, a blank one counts as missing', () => {
  const other = checkDraft({ draft: { blocks: [{ profile_ref: 'profile:other' }] }, required_ref_fields: ['profile_ref'], profile_ref: 'profile:bakery-voice' });
  assert.equal(other.fits, false);
  assert.match(other.rules[0].reason, /names another profile/);
  const blank = checkDraft({ draft: { blocks: [{ profile_ref: '  ' }] }, required_ref_fields: ['profile_ref'] });
  assert.equal(blank.fits, false);
});

test('a check that does not say which fields to look at is refused', () => {
  assert.throws(() => checkDraft({ draft: { blocks: [] } }), /required_ref_fields must name/);
  assert.throws(() => checkDraft({ draft: { blocks: 'x' }, required_ref_fields: ['a'] }), /draft.blocks must be a list/);
});

const run = (script, input) => new Promise((resolve) => {
  const child = execFile('node', [join(folder, 'do-work', script)], { cwd: folder }, (error, stdout) => resolve({ code: error?.code ?? 0, out: JSON.parse(stdout.trim().split('\n').at(-1)) }));
  child.stdin.end(JSON.stringify(input));
});

test('each row runs as the container runs it and its sample gives the text it promises', async () => {
  const rows = JSON.parse(await readFile(join(folder, 'tool-rows.json'), 'utf8')).records.map((record) => record.payload);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const [sample] = row.verify;
    const script = row.invoke.argv[1].replace('do-work/', '');
    const { code, out } = await run(script, sample.input);
    assert.equal(code, 0, row.id);
    const path = sample.output_selector.replace('$.', '').split('.');
    const value = path.reduce((from, key) => from[key], out.result);
    assert.ok(JSON.stringify(value).includes(sample.contains), row.id);
  }
});

test('a refused request prints its reason and fails', async () => {
  const { code, out } = await run('keep-a-profile.mjs', { ...base, derived_items: [] });
  assert.equal(code, 1);
  assert.match(out.error, /non-empty list/);
});

test('the folder names no one: no real subject, no path, no house list', async () => {
  for (const file of ['read-data/profile.mjs', 'tool-rows.json', 'README.md']) {
    const body = await readFile(join(folder, file), 'utf8');
    assert.doesNotMatch(body, /\/Users\//, file);
    assert.doesNotMatch(body, /@[a-z0-9-]+\.[a-z]{2,}/i, file);
  }
});
