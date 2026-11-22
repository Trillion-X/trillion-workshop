// tools/keep-and-wake-ai-sessions-on-this-computer/test/chosen-ai-from-the-row.test.mjs
//
// A computer made from its row (a server) keeps no hand-chosen settings file; its row renders take-open-work.computer.json.
// The chosen AI, its order and the computer's values are read from that too, under the hand-kept ones: the server's taker
// found no chosen AI and never started for 10 hours (Nov 21 2026), so no turn could be handed to it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { aiOrder, chooseAi, chosenAi, computerSettings } from '../harness/chosen-ai.mjs';

const computer = () => {
  const root = mkdtempSync(join(tmpdir(), 'chosen-ai-'));
  const rules = { folder: join(root, 'wake-sessions'), settings_file: 'settings.json', taker_state_folder: join(root, 'take-open-work') };
  const row = values => { mkdirSync(rules.taker_state_folder, { recursive: true }); writeFileSync(join(rules.taker_state_folder, 'take-open-work.computer.json'), JSON.stringify(values)); };
  return { rules, row, done: () => rmSync(root, { recursive: true, force: true }) };
};

it('nothing chosen anywhere is still nothing chosen', () => {
  const { rules, done } = computer();
  try {
    assert.equal(chosenAi(rules), null);
    assert.deepEqual(aiOrder(rules), []);
    assert.deepEqual(computerSettings(rules), {});
  } finally { done(); }
});

it('a computer whose row names its AIs takes work with them, and its row values are its settings', () => {
  const { rules, row, done } = computer();
  try {
    row({ chosen_ai: 'claude', then_ai: ['codex'], tasks_store: 'some-store-connection' });
    assert.equal(chosenAi(rules), 'claude');
    assert.deepEqual(aiOrder(rules), ['claude', 'codex']);
    assert.equal(computerSettings(rules).tasks_store, 'some-store-connection');
  } finally { done(); }
});

it('a choice kept by hand on the computer wins over its row, value by value', () => {
  const { rules, row, done } = computer();
  try {
    row({ chosen_ai: 'claude', then_ai: ['codex'], tasks_store: 'some-store-connection' });
    chooseAi('codex', rules);
    assert.equal(chosenAi(rules), 'codex');
    assert.deepEqual(aiOrder(rules), ['codex']);
    assert.equal(computerSettings(rules).tasks_store, 'some-store-connection', 'a value only the row names is kept');
  } finally { done(); }
});

it('a row file that is not an object, or unreadable, adds nothing', () => {
  const { rules, done } = computer();
  try {
    mkdirSync(rules.taker_state_folder, { recursive: true });
    writeFileSync(join(rules.taker_state_folder, 'take-open-work.computer.json'), '["claude"]');
    assert.equal(chosenAi(rules), null);
    writeFileSync(join(rules.taker_state_folder, 'take-open-work.computer.json'), '{not json');
    assert.equal(chosenAi(rules), null);
  } finally { done(); }
});
