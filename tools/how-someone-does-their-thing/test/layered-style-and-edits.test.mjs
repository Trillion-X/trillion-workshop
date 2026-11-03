// tools/how-someone-does-their-thing: the layered writing style and the repeated-edit finder. Every writer, phrase and
// company here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keepProfile } from '../read-data/profile.mjs';
import { layerAWritingStyle, WRITING_LAYERS } from '../read-data/layers.mjs';
import { findRepeatedEdits } from '../read-data/edits.mjs';

const niche = { level: 'niche', id: 'niche:garden-trades', fields: { diction: { prefer: ['quote', 'visit'], avoid: ['solutions'] }, 'syntax.sentence_words': { max: 20 } } };
const group = { level: 'group', id: 'group:acme-lawns', fields: { rules: [{ id: 'first-line-local', text: 'Put one local detail in the first line.' }], register: 'Friendly and brief.' } };
const person = { level: 'person', id: 'person:sample-writer', fields: { 'diction.phrases': [{ text: 'worth a look', source: 'post:1' }], syntax: { openers: ['a question'], sentence_words: { min: 4 } } } };

test('layers merge base to person, later fields override and lists extend', () => {
  const merged = layerAWritingStyle({ layers: [niche, group, person] });
  assert.deepEqual(merged.layers.map((layer) => layer.level), ['base', 'niche', 'group', 'person']);
  assert.deepEqual(merged.style['syntax.sentence_words'], { max: 20, min: 4 });
  assert.equal(merged.style.register, 'Friendly and brief.');
  assert.deepEqual(merged.style['diction.avoid'], ['revolutionary', 'game-changing', 'synergy', 'cutting-edge', 'solutions']);
  assert.deepEqual(merged.style.rules.map((rule) => rule.id), ['no-invented-evidence', 'evidence-apart-from-inference', 'specific-over-general', 'first-line-local']);
});

test('every value says which layers set it, and the instruction and items carry them', () => {
  const merged = layerAWritingStyle({ layers: [niche, group, person] });
  assert.deepEqual(merged.provenance['syntax.sentence_words'].map((entry) => entry.id), ['base', 'niche:garden-trades', 'person:sample-writer']);
  assert.match(merged.instruction_text, /Never use these words and phrases: revolutionary; game-changing; synergy; cutting-edge; solutions\./);
  assert.match(merged.instruction_text, /Register: Friendly and brief\./);
  const phrase = merged.items.find((item) => item.kind === 'diction.phrases');
  assert.equal(phrase.evidence, 'layer:person:person:sample-writer');
  const profile = keepProfile({ profile_ref: 'profile:sample-writer', subject_ref: 'person:sample-writer', derived_items: merged.items });
  assert.equal(profile.derived_items.length, merged.items.length);
});

test('replace starts a list again and off drops an earlier entry by value or by rule id', () => {
  const replaced = layerAWritingStyle({ layers: [niche, { level: 'person', id: 'p', fields: { 'diction.avoid': ['very'] }, replace: ['diction.avoid'] }] });
  assert.deepEqual(replaced.style['diction.avoid'], ['very']);
  const dropped = layerAWritingStyle({ layers: [niche, { level: 'person', id: 'p', fields: { register: 'Dry.' }, off: ['solutions', 'specific-over-general'] }] });
  assert.ok(!dropped.style['diction.avoid'].includes('solutions'));
  assert.ok(!dropped.style.rules.some((rule) => rule.id === 'specific-over-general'));
  assert.ok(dropped.provenance.rules.some((entry) => entry.off?.includes('specific-over-general')));
});

test('a caller\'s own base replaces the shipped one', () => {
  const merged = layerAWritingStyle({ layers: [{ level: 'base', id: 'base:mine', fields: { register: 'Mine.' } }, person] });
  assert.equal(merged.style.register, 'Mine.');
  assert.equal(merged.style['diction.avoid'], undefined);
});

test('layers out of order, unknown levels or fields, a missing id and a drop of nothing are refused with what to fix', () => {
  assert.throws(() => layerAWritingStyle({ layers: [person, niche] }), /comes before the level of the layer above it/);
  assert.throws(() => layerAWritingStyle({ layers: [{ ...niche, level: 'team' }] }), /not a level: use one of base, niche, group, person/);
  assert.throws(() => layerAWritingStyle({ layers: [{ level: 'niche', id: 'n', fields: { tone: 'warm' } }] }), /"tone", which is not a field/);
  assert.throws(() => layerAWritingStyle({ layers: [{ level: 'niche', fields: {} }] }), /\.id must name the layer/);
  assert.throws(() => layerAWritingStyle({ layers: [{ level: 'niche', id: 'n', fields: { 'diction.avoid': [] } }] }), /non-empty list/);
  assert.throws(() => layerAWritingStyle({ layers: [{ level: 'niche', id: 'n', fields: {}, off: ['nothing here'] }] }), /which no earlier layer set/);
  assert.throws(() => layerAWritingStyle({ layers: 'x' }), /list of layer objects/);
});

test('a data file with no base is refused, and a field added only as a row is merged', () => {
  assert.throws(() => layerAWritingStyle({}, { ...WRITING_LAYERS, layers: [] }), /no base layer/);
  assert.throws(() => layerAWritingStyle({}, { ...WRITING_LAYERS, levels: [{ level: 'person' }] }), /no base level/);
  const data = { ...WRITING_LAYERS, fields: [...WRITING_LAYERS.fields, { field: 'tone.humour', merge: 'text', says: 'Humour: {value}' }] };
  const merged = layerAWritingStyle({ layers: [{ level: 'person', id: 'p', fields: { tone: { humour: 'dry' } } }] }, data);
  assert.match(merged.instruction_text, /Humour: dry/);
});

const pair = (id, original, edited) => ({ id, original, edited });
const drafts = [
  pair('d1', 'We utilize the best tools for your yard.', 'We use the best tools for your yard.'),
  pair('d2', 'Our team will utilize a plan. Call today!', 'Our team will use a plan. Call today.'),
  pair('d3', 'I utilize local crews, honestly.', 'I use local crews.'),
  pair('d4', 'A fresh lawn is great.', 'A fresh lawn is great.'),
];

test('a change recurring in enough different drafts is a candidate with its example and counts', () => {
  const found = findRepeatedEdits({ pairs: drafts });
  const replace = found.candidates.find((candidate) => candidate.from === 'utilize');
  assert.deepEqual([replace.rule, replace.to, replace.distinct_drafts, replace.draft_ids], ['replace', 'use', 3, ['d1', 'd2', 'd3']]);
  assert.equal(replace.example.id, 'd1');
  assert.equal(found.drafts, 4);
  assert.ok(found.below_threshold >= 1);
  assert.match(found.said, /candidates only/);
});

test('a change in fewer drafts than the minimum is not proposed, and the minimum is the caller\'s knob', () => {
  assert.equal(findRepeatedEdits({ pairs: drafts }).candidates.some((candidate) => candidate.from === 'honestly'), false);
  const strict = findRepeatedEdits({ pairs: drafts, min_distinct_drafts: 4 });
  assert.deepEqual(strict.candidates, []);
  assert.match(strict.said, /No change recurred/);
});

test('one draft sent twice counts once and a removal and an addition are told apart', () => {
  const twice = findRepeatedEdits({ min_distinct_drafts: 2, pairs: [pair('a', 'Very good plan.', 'Good plan.'), pair('a', 'Very good plan.', 'Good plan.'), pair('b', 'It is very hot.', 'It is hot.'), pair('c', 'Hello.', 'Hello there.')] });
  const avoid = twice.candidates.find((candidate) => candidate.from === 'very');
  assert.deepEqual([avoid.rule, avoid.to, avoid.distinct_drafts], ['avoid', '', 2]);
});

test('too few drafts, a bad minimum or a bad pair is refused with what to send', () => {
  assert.throws(() => findRepeatedEdits({ pairs: drafts.slice(0, 2) }), /needs the same change in at least 3/);
  assert.throws(() => findRepeatedEdits({ pairs: [pair('a', 'x', 'y'), pair('a', 'x', 'z')], min_distinct_drafts: 2 }), /1 different draft sent/);
  assert.throws(() => findRepeatedEdits({ pairs: drafts, min_distinct_drafts: 1 }), /never makes a rule/);
  assert.throws(() => findRepeatedEdits({ pairs: [{ original: 'a', edited: 'b' }] }), /\.id must name the draft/);
  assert.throws(() => findRepeatedEdits({ pairs: [pair('a', 1, 'b')] }), /original and edited as text/);
  assert.throws(() => findRepeatedEdits({ pairs: [pair('a', 'w '.repeat(5001), 'b')], min_distinct_drafts: 2 }), /over 5000 words/);
});
