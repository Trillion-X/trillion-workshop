// tools/ui/show/notifications/test/notification-words.test.mjs
//
// A notification shows a person no engine text: a raw failure (a tool id, a source path, a hex run, a JSON dump) is
// replaced by the kind's words, and the raw words are kept only for Details. Runs the real notification-words.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const entry = fileURLToPath(new URL('../notification-words.ts', import.meta.url));
const { code } = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, platform: 'neutral' }).then(r => ({ code: r.outputFiles[0].text }));
const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const words = await import(dataUrl);

const RAW_TITLE = 'tool:run-a-workflow a-step-was-answered stopped: engine::tool_runs::tools::container@src/tool_runs/tools/container.rs:959:21:condition: process_exit_unsuccessful#4e72971e0f686696fbf20f7607494c1fe8d5423b';
const RAW_DETAIL = 'It stopped because: {"error":"a definition does not decode: missing field `id`"}.';
const kinds = { error: { icon: 'CircleAlert', gate_words: { title: 'That did not work.', detail: '' } } };
const sourcePath = /src\/|\.rs\b|\.ts\b|::/;
const hexRun = /\b[0-9a-f]{32,}\b/i;
const json = /[{}]/;

test('an engine failure with no gate words of its own shows the default words, never the raw text', () => {
  const shown = words.shownWords({ kind: 'notice', title: RAW_TITLE, detail: RAW_DETAIL }, kinds);
  assert.equal(shown.title, 'Something did not work.');
  assert.equal(shown.detail, '');
  for (const text of [shown.title, shown.detail]) {
    assert.doesNotMatch(text, sourcePath);
    assert.doesNotMatch(text, hexRun);
    assert.doesNotMatch(text, json);
  }
});

test('a kind with its own gate words uses them', () => {
  assert.equal(words.shownWords({ kind: 'error', title: RAW_TITLE, detail: RAW_DETAIL }, kinds).title, 'That did not work.');
});

test('a plain message passes unchanged and has no Details', () => {
  const plain = { kind: 'notice', title: 'Your recording is saved', detail: 'Saved in Files' };
  assert.deepEqual(words.shownWords(plain, kinds), { title: 'Your recording is saved', detail: 'Saved in Files' });
  assert.equal(words.rawWordsOf(plain, kinds), null);
});

test('the raw words are kept for Details when the gate changes them', () => {
  const raw = words.rawWordsOf({ kind: 'notice', title: RAW_TITLE, detail: RAW_DETAIL }, kinds);
  assert.ok(raw.includes('tool:run-a-workflow'));
  assert.ok(raw.includes('missing field'));
});
