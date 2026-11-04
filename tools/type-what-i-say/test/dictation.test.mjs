// Dictation on this Mac (read-data/dictation.mjs, DATA in read-data/dictation.json): the cleaning pipeline in DATA order,
// dictionary and snippets as the person's own rows with the full row lifecycle, learning from an edit, the clipboard
// transaction that always restores, and the key table that stops a lost key-up.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { biasPrompt, clean, dictationSettings, dictationTools, insertText, keyMachine, learnChanges, newEntryId, readRows, recordDictation, rowId, wordChanges } from '../read-data/dictation.mjs';

const base = dictationSettings();
const withState = () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'dictation-'));
  return { settings: { ...base, state }, state };
};

test('spoken commands, style and the person dictionary run in the order the DATA names', () => {
  const rows = [{ kind: 'dictionary', from: 'trillion ai', to: 'Trillion', active: true }, { kind: 'snippet', says: 'my email', expands_to: 'me@example.com' }];
  const made = clean('Hello trillion ai. New line send it to my email. New paragraph thanks', { settings: base, rows, context: { app: 'Notes' } });
  assert.equal(made.text, 'Hello Trillion.\nsend it to me@example.com.\n\nthanks');
  assert.deepEqual(made.applied, base.pipeline);
  const chat = clean('Sounds good to Trillion AI.', { settings: base, rows: [{ kind: 'dictionary', from: 'trillion ai', to: 'Trillion', active: true }], context: { app: 'Slack' } });
  assert.equal(chat.text, 'sounds good to Trillion', 'the chat style lowercases and strips the period before the dictionary restores its own case');
});

test('"scratch that" drops the sentence before it, and an unknown pipeline step is skipped and said, not guessed', () => {
  assert.equal(clean('First thing. Second thing is wrong. Scratch that. Third thing.', { settings: base }).text, 'First thing. Third thing.');
  const made = clean('hello', { settings: { ...base, pipeline: ['trim', 'made-up-step'] } });
  assert.deepEqual(made.skipped, ['made-up-step']);
  assert.equal(made.text, 'hello');
});

test('the dictate tool creates, reads, edits and deletes the person rows and persists them', async () => {
  const { settings, state } = withState();
  const added = await dictationTools.dictate({ action: 'add', from: 'kubernetes', to: 'Kubernetes' }, { settings });
  assert.equal(added.row.id, rowId('dictionary', 'kubernetes\u0000Kubernetes'));
  await dictationTools.dictate({ action: 'add', kind: 'snippet', says: 'sign off', expands_to: 'Best, Ana' }, { settings });
  assert.equal((await dictationTools.dictate({ action: 'list' }, { settings })).rows.length, 2);
  assert.equal((await dictationTools.dictate({ action: 'clean', text: 'deploy kubernetes then sign off' }, { settings })).text, 'deploy Kubernetes then Best, Ana');
  await dictationTools.dictate({ action: 'edit', id: added.row.id, to: 'K8s' }, { settings });
  assert.equal((await dictationTools.dictate({ action: 'clean', text: 'kubernetes' }, { settings })).text, 'K8s');
  await dictationTools.dictate({ action: 'delete', id: added.row.id }, { settings });
  assert.equal(readRows(settings).length, 1);
  await assert.rejects(dictationTools.dictate({ action: 'delete', id: 'nope' }, { settings }), { status: 404 });
  await assert.rejects(dictationTools.dictate({ action: 'frobnicate' }, { settings }), /Unknown action/);
  const kept = JSON.parse(readFileSync(path.join(state, 'rows.json'), 'utf8'));
  console.log('REAL readback of the rows file after the lifecycle:', JSON.stringify(kept));
  rmSync(state, { recursive: true });
});

test('an edit teaches short replacements; one seen twice becomes active, and a taught row is never overwritten', async () => {
  assert.deepEqual(wordChanges('I use cooper netties daily', 'I use Kubernetes daily'), [{ from: 'cooper netties', to: 'Kubernetes' }]);
  assert.deepEqual(wordChanges('Same words here.', 'same words here'), [], 'case and punctuation alone are not a lesson');
  assert.deepEqual(wordChanges('one two three four five six', 'a b c d e f'), [], 'a rewrite longer than learn.most_words is not a word fix');
  const once = learnChanges([], [{ from: 'cooper netties', to: 'Kubernetes' }], base);
  assert.equal(once[0].active, false);
  assert.equal(clean('cooper netties', { settings: base, rows: once }).text, 'cooper netties');
  const twice = learnChanges(once, [{ from: 'cooper netties', to: 'Kubernetes' }], base);
  assert.equal(twice[0].active, true);
  assert.equal(clean('cooper netties', { settings: base, rows: twice }).text, 'Kubernetes');
  const taught = [{ id: 't', kind: 'dictionary', from: 'cooper netties', to: 'Mine', taught: true, active: true }];
  assert.deepEqual(learnChanges(taught, [{ from: 'cooper netties', to: 'Other' }], base), taught);
  const { settings, state } = withState();
  const learned = await dictationTools.dictate({ action: 'learn', inserted: 'ask cooper netties', final: 'ask Kubernetes' }, { settings });
  assert.equal(learned.changes.length, 1);
  assert.equal(readRows(settings)[0].learned, true);
  rmSync(state, { recursive: true });
});

test('the hearing prompt carries dictionary, names and the app, and is cut to its limits', () => {
  const rows = [{ kind: 'dictionary', from: 'x', to: 'Kubernetes', active: true }, { kind: 'dictionary', from: 'y', to: 'Hidden', active: false }];
  const prompt = biasPrompt({ settings: base, rows, context: { app: 'Linear', names: ['Priya', 'Kubernetes'], screen_text: 'Roadmap review with Dmitri today' } });
  assert.equal(prompt, 'Words that may come up: Kubernetes, Priya, Linear, Roadmap, Dmitri.');
  const long = biasPrompt({ settings: { ...base, bias: { ...base.bias, most_characters: 40 } }, rows, context: { names: ['Priya', 'Bartholomew', 'Anastasia'] } });
  assert.ok(long.length <= 40, long);
  assert.equal(biasPrompt({ settings: base }), '');
});

const fakeClipboard = (start, { failPaste = false, kinds = '«class utf8», 12, string, 12' } = {}) => {
  const log = []; let clip = start;
  return {
    log, clip: () => clip,
    run: async (argv, input = '') => {
      const word = argv[0].split('/').pop() + (argv[1] === '-e' ? `:${argv[2].split(' ').slice(0, 3).join(' ')}` : '');
      log.push(word);
      if (argv[0].endsWith('pbpaste')) return clip;
      if (argv[0].endsWith('pbcopy')) { clip = input; return ''; }
      if (argv[2] === 'clipboard info') return kinds;
      if (argv[2].includes('keystroke')) { if (failPaste) throw new Error('no accessibility'); return ''; }
      return `field with ${clip}`;
    },
  };
};

test('inserting text is a clipboard transaction: saved, written, pasted, restored, verified, and restored on failure too', async () => {
  const ok = fakeClipboard('my old clipboard');
  const done = await insertText('Hello world', { settings: base, run: ok.run, pause: async () => {} });
  assert.deepEqual({ ...done, entry_id: typeof done.entry_id }, { entry_id: 'string', kind: 'inserted-verified', saved: true, wrote: true, pasted: true, restored: true, verified: true, error: null });
  assert.equal(ok.clip(), 'my old clipboard');
  const broken = fakeClipboard('keep me', { failPaste: true });
  const failed = await insertText('Hello', { settings: base, run: broken.run, pause: async () => {} });
  assert.equal(failed.pasted, false);
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.restored, true);
  assert.equal(failed.error, 'no accessibility');
  assert.equal(broken.clip(), 'keep me', 'a failed paste still gives the clipboard back');
  const picture = fakeClipboard('x', { kinds: '«class PNGf», 5000, «class utf8», 3' });
  const refused = await insertText('Hello', { settings: base, run: picture.run, pause: async () => {} });
  assert.equal(refused.pasted, false);
  assert.equal(refused.kind, 'blocked');
  assert.match(refused.error, /pngf/);
  assert.deepEqual(picture.log, ['osascript:clipboard info'], 'a clipboard it cannot put back is never touched');
});

test('push-to-talk holds, hands-free toggles, and a lost key-up or a too-long run is stopped', () => {
  let clock = 0; const events = []; let down = true;
  const keys = { 'push-to-talk': { mode: 'hold' }, 'hands-free': { mode: 'toggle' }, most_seconds: 60 };
  const machine = keyMachine(keys, { start: action => events.push(`start ${action}`), stop: (action, why) => events.push(`stop ${action} ${why}`) }, { now: () => clock, stillDown: () => down });
  machine.event('push-to-talk', 'down'); machine.event('push-to-talk', 'down'); machine.event('push-to-talk', 'up');
  machine.event('hands-free', 'down'); machine.event('hands-free', 'up'); machine.event('hands-free', 'down');
  machine.event('push-to-talk', 'down'); down = false; machine.tick();
  machine.event('hands-free', 'down'); clock = 61_000; machine.tick();
  assert.deepEqual(events, [
    'start push-to-talk', 'stop push-to-talk released',
    'start hands-free', 'stop hands-free toggled',
    'start push-to-talk', 'stop push-to-talk key-not-down',
    'start hands-free', 'stop hands-free too-long',
  ]);
});

test('one entry id runs through cleaning, inserting and learning, and the history is bounded, listable and erasable', async () => {
  const { settings, state } = withState();
  const cleaned = await dictationTools.dictate({ action: 'clean', text: 'hello world', context: { app: 'Notes' } }, { settings });
  const clip = fakeClipboard('old');
  const inserted = await dictationTools.dictate({ action: 'insert', text: cleaned.text, entry_id: cleaned.entry_id, context: { app: 'Notes' } }, { settings, run: clip.run });
  assert.equal(inserted.entry_id, cleaned.entry_id);
  assert.equal(inserted.kind, 'inserted-verified');
  const learned = await dictationTools.dictate({ action: 'learn', entry_id: cleaned.entry_id, inserted: 'hello world', final: 'hello there' }, { settings });
  assert.equal(learned.entry_id, cleaned.entry_id);
  const listed = await dictationTools.dictate({ action: 'history' }, { settings });
  assert.deepEqual(listed.entries.map(entry => [entry.entry_id, entry.app, entry.kind, entry.text]), [[cleaned.entry_id, 'Notes', 'inserted-verified', 'hello world']]);
  const keepNoText = { ...settings, history: { ...settings.history, keep_text: false, most: 2 } };
  for (let at = 0; at < 3; at += 1) recordDictation(keepNoText, { entry_id: `e${at}`, kind: 'failed' }, Date.now() + at);
  assert.deepEqual((await dictationTools.dictate({ action: 'history' }, { settings: keepNoText })).entries.map(entry => [entry.entry_id, 'text' in entry]), [['e1', false], ['e2', false]], 'bounded by most, no text kept');
  recordDictation(settings, { entry_id: 'old', kind: 'failed' }, Date.now() - 31 * 86_400_000);
  recordDictation(settings, { entry_id: 'new', kind: 'failed' });
  assert.ok(!(await dictationTools.dictate({ action: 'history' }, { settings })).entries.some(entry => entry.entry_id === 'old'), 'past keep_days it is gone');
  await assert.rejects(dictationTools.dictate({ action: 'erase', entry_id: 'nope' }, { settings }), { status: 404 });
  assert.deepEqual(await dictationTools.dictate({ action: 'erase', entry_id: 'new' }, { settings }), { erased: 1 });
  const all = await dictationTools.dictate({ action: 'erase' }, { settings });
  assert.ok(all.erased >= 1);
  assert.deepEqual((await dictationTools.dictate({ action: 'history' }, { settings })).entries, []);
  assert.match(newEntryId(), /^[0-9a-f]{16}$/);
  console.log('REAL readback of a history listing:', JSON.stringify(listed.entries));
  rmSync(state, { recursive: true });
});

test('polish and command are model steps through the dictate tool; no answer or a wrong shape leaves the text as it was', async () => {
  const { settings, state } = withState();
  const asked = [];
  const answer = content => async request => { asked.push(request); return { model: 'fake', choices: [{ message: { content } }] }; };
  const polished = await dictationTools.dictate({ text: 'um hello trillion ai how are you', polish: true }, { settings, askModel: answer(JSON.stringify({ text: 'Hello, Trillion. How are you?' })) });
  assert.equal(polished.text, 'Hello, Trillion. How are you?');
  assert.deepEqual(polished.model, { changed: true, said: null, by: 'fake' });
  assert.equal(asked[0].job, settings.polish.job);
  const commanded = await dictationTools.dictate({ text: 'meet at three', command: 'make it formal' }, { settings, askModel: answer(JSON.stringify({ text: 'Let us meet at three o\'clock.' })) });
  assert.match(asked[1].messages[1].content, /Instruction: make it formal/);
  assert.equal(commanded.text, 'Let us meet at three o\'clock.');
  const wrong = await dictationTools.dictate({ text: 'keep this', polish: true }, { settings, askModel: answer('not json') });
  assert.equal(wrong.text, 'keep this');
  assert.match(wrong.model.said, /left as it was/);
  const none = await dictationTools.dictate({ text: 'keep this too', polish: true }, { settings, askModel: async () => ({ error: 'down' }) });
  assert.equal(none.text, 'keep this too');
  rmSync(state, { recursive: true });
});
