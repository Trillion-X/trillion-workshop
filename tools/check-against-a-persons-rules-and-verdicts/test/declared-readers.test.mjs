// tools/check-against-a-persons-rules-and-verdicts: the declared readers (sections, cue narration, JSON roles) read only
// what their profile or owner names, count what they leave out without keeping its text, and turn every shape they cannot
// read into an issue, which tool:check-copy reports as a problem. Every document, profile and word here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wordsOfCueNarration, wordsOfJsonRoles, wordsOfSections } from '../do-work/read-words.mjs';
import { check } from '../do-work/rules-and-verdicts.mjs';
import { checkCopy } from '../do-work/check-copy.mjs';

const SECTIONS = {
  title_kind: 'title',
  sections: [{ heading: 'Article', kind: 'narrator' }, { heading: 'Spoken script', kind: 'voiceover', keeps_headings: true }],
  required: ['Article', 'Spoken script'],
  fields: { title: 'title', narrator: 'body', voiceover: 'body' },
};
const CUES = {
  kind: 'voiceover', field: 'body', cue_heading_level: 2, cue_id_pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  frontmatter: { fields: { voice: 'string', speed: 'number', gap: 'number' }, required: [] },
};
const kinds = issues => issues.map(issue => issue.kind);

test('sections read the title, each declared section and its subheadings, and count preamble and quotes without keeping them', () => {
  const read = wordsOfSections('# Plum fields\n\nSource note: made-up private metadata\nAnother note: made-up private metadata\n\n'
    + '## Article\nThe first plum paragraph.\n### A plum subheading\nA paragraph under it.\n> A quoted source line.\n'
    + '## Spoken script\nThe narrator speaks here.\n## Scene two\nThe scene goes on.\n', 'plums.md', SECTIONS);
  assert.deepEqual(read.units.map(unit => [unit.text, unit.kind, unit.field]), [
    ['Plum fields', 'title', 'title'], ['The first plum paragraph.', 'narrator', 'body'], ['A plum subheading', 'title', 'title'],
    ['A paragraph under it.', 'narrator', 'body'], ['The narrator speaks here.', 'voiceover', 'body'], ['Scene two', 'title', 'title'],
    ['The scene goes on.', 'voiceover', 'body']]);
  assert.equal(read.units[1].where, 'plums.md:7');
  assert.equal(read.public_body_units, 4);
  assert.deepEqual(read.excluded, { preamble_lines: 2, unresolved_quote_lines: 1 });
  assert.deepEqual(kinds(read.issues), ['unresolved_quote_role']);
  const kept = JSON.stringify(read);
  assert.ok(!kept.includes('made-up private metadata') && !kept.includes('A quoted source line.'));
});

test('sections refuse a missing required section, text under an unknown section, and a profile they cannot use', () => {
  const read = wordsOfSections('# Grape title\n\n## Article\nArticle words.\n## Mystery\nUnclassified words.\n', 'grape.md', SECTIONS);
  assert.deepEqual(kinds(read.issues), ['unknown_section', 'content_under_unrecognized_section', 'missing_required_section']);
  assert.equal(read.units.some(unit => unit.text.includes('Unclassified')), false);
  assert.deepEqual(kinds(wordsOfSections('## Article\n', 'x.md', SECTIONS).issues), ['missing_document_title', 'missing_required_section', 'missing_public_body']);
  assert.deepEqual(kinds(wordsOfSections('# T\n', 'x.md', { title_kind: 'title' }).issues), ['invalid_reader_profile']);
});

test('cue narration keeps declared metadata, cue ids and one unit per wrapped paragraph', () => {
  const read = wordsOfCueNarration('---\nvoice: made_up_voice\nspeed: 1.0\ngap: 0.35\n---\n'
    + '## open\nA zorblax ladder is one long\nset. You climb each rung.\n\n## top\nAt the top rung, you rest once.\n', 'cues.md', CUES);
  assert.deepEqual(read.frontmatter, { voice: 'made_up_voice', speed: 1, gap: 0.35 });
  assert.deepEqual(read.cue_ids, ['open', 'top']);
  assert.deepEqual(read.units.map(unit => [unit.cue_id, unit.text, unit.field]), [
    ['open', 'A zorblax ladder is one long set. You climb each rung.', 'body'], ['top', 'At the top rung, you rest once.', 'body']]);
  assert.equal(read.units[0].where, 'cues.md:7');
  assert.deepEqual(read.issues, []);
  const plain = wordsOfCueNarration('## sound\nYou heard the plum drop.\n\nStart there. What did you hear?\n\n## next\nThe map has seven rungs.\n', 'plain.md', CUES);
  assert.deepEqual(plain.frontmatter, {});
  assert.deepEqual(plain.units.map(unit => unit.cue_id), ['sound', 'sound', 'next']);
});

test('cue narration turns quotes, code, unknown shapes, bad metadata and empty or missing cues into issues, never words', () => {
  const cases = [
    ['## cue\n> Quoted words.\n', 'unresolved_quote'],
    ['## cue\n```\nmade_up_fenced_payload\n```\n', 'code_shape'],
    ['## cue\nUse `code` here.\n', 'code_shape'],
    ['## cue\n    ## fake\n', 'code_shape'],
    ['## cue\n- A list item.\n', 'unknown_content_shape'],
    ['### subheading\nWords outside a cue.\n', 'unknown_heading_shape'],
    ['---\nsecret: x\n---\n## cue\nWords.\n', 'unknown_frontmatter_field'],
    ['---\nspeed: fast\n---\n## cue\nWords.\n', 'invalid_frontmatter_value'],
    ['## cue\n\n## next\nWords.\n', 'empty_cue'],
    ['## cue\nFirst.\n## cue\nSecond.\n', 'duplicate_cue_id'],
    ['Only prose, with no cue headings.\n', 'missing_cues'],
  ];
  for (const [source, issue] of cases) {
    const read = wordsOfCueNarration(source, 'cues.md', CUES);
    assert.ok(kinds(read.issues).includes(issue), `${issue}: ${JSON.stringify(read.issues)}`);
    assert.ok(!JSON.stringify(read.units).includes('Quoted words.') && !JSON.stringify(read.units).includes('made_up_fenced_payload'));
  }
  assert.deepEqual(kinds(wordsOfCueNarration('## cue\nWords.\n', 'cues.md', { kind: 'voiceover' }).issues), ['invalid_reader_profile']);
});

const FORM = {
  saved: { label: 'Your notes', fields: [{ label: 'Reflection' }], answers: ['MADE_UP_ANSWER_SENTINEL'] },
  source: [{ text: 'MADE_UP_SOURCE_SENTINEL' }],
  protocol: { policy: 'Keep the source.', steps: [{ prompt: 'Choose an attempt.' }] },
};

test('JSON roles read only the owner\'s paths, each with its role\'s kind and field, and never another string', () => {
  const labels = wordsOfJsonRoles(FORM, 'form.json', { paths: ['saved.label', 'saved.fields.*.label'], kind: 'label', field: 'label' });
  assert.deepEqual(labels.units.map(unit => [unit.text, unit.kind, unit.field, unit.where]), [
    ['Your notes', 'label', 'label', 'form.json#saved.label'], ['Reflection', 'label', 'label', 'form.json#saved.fields.0.label']]);
  assert.deepEqual(labels.issues, []);
  const material = wordsOfJsonRoles(FORM, 'form.json', { paths: ['saved.label', 'protocol.**'], kind: 'copy',
    roles: [{ paths: ['saved.label'], kind: 'label', field: 'label' }, { paths: ['protocol.**'], kind: 'instruction', field: 'body', context_requires_review: true }] });
  assert.deepEqual(material.issues, []);
  assert.deepEqual(material.units.map(unit => [unit.text, unit.kind, Boolean(unit.context_requires_review)]), [
    ['Your notes', 'label', false], ['Keep the source.', 'instruction', true], ['Choose an attempt.', 'instruction', true]]);
  const kept = JSON.stringify([labels, material]);
  assert.ok(!kept.includes('MADE_UP_ANSWER_SENTINEL') && !kept.includes('MADE_UP_SOURCE_SENTINEL'));
  const { results } = check(material.units.filter(unit => unit.context_requires_review), [{ id: 'no-zorblax', words: ['source'], says: 'No source.' }]);
  assert.ok(results.every(result => result.verdict === 'uncertain' && result.qualification === 'context-unqualified'));
});

test('JSON roles name a string two roles claim, a string no role claims, a role outside the owner\'s paths and an owner that reads nothing', () => {
  const read = wordsOfJsonRoles(FORM, 'form.json', { paths: ['saved.label', 'protocol.policy'], kind: 'copy',
    roles: [{ paths: ['saved.label'], kind: 'label', field: 'label' }, { paths: ['saved.label', 'source.*.text'], kind: 'quote', field: 'body' }] });
  assert.deepEqual(kinds(read.issues), ['ambiguous_word_role', 'role_outside_selected_words', 'unclassified_word_role']);
  assert.deepEqual(kinds(wordsOfJsonRoles(FORM, 'form.json', { paths: ['nowhere'], kind: 'copy' }).issues), ['owner_paths_matched_no_words']);
  assert.deepEqual(kinds(wordsOfJsonRoles(FORM, 'form.json', { paths: [], kind: 'copy' }).issues), ['invalid_json_owner']);
});

test('tool:check-copy judges the declared readers\' units and reports each reader issue as a problem', () => {
  const rules = [{ id: 'no-zorblax', words: ['zorblax'], says: 'No zorblax.' }];
  const clean = checkCopy({ rules, cue_narration: [{ text: '## open\nOpen any file you keep.\n', where: 'cues.md', profile: CUES }] });
  assert.equal(clean.status, 'passed');
  assert.equal(clean.results[0].cue_id, 'open');
  const failed = checkCopy({ rules, sections: [{ text: '# A title\n## Article\nA zorblax line.\n', where: 's.md', profile: SECTIONS }],
    json_roles: [{ json: FORM, where: 'form.json', owner: { paths: ['saved.label'], kind: 'label' } }] });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.problems, ['s.md: missing_required_section']);
  assert.deepEqual(failed.results.filter(result => result.verdict === 'fail').map(result => result.text), ['A zorblax line.']);
});
