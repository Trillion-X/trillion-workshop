import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, classifyTab, planIntake, readArcTabs } from '../do-work/arc-inspiration-intake.mjs';

// Stands in for the BLAKE3 owner: a fixed 64 hex digest per input, so ids are stable in the test.
const blake3Hex = text => text.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0').slice(0, 64);

const space = { id: 'S1', title: 'Work' };
const folder = { parentID: null, data: { itemContainer: { containerType: { spaceItems: { _0: 'S1' } } } } };
const tab = (savedURL, savedTitle) => ({ parentID: 'F1', data: { tab: { savedURL, savedTitle } } });
const fixture = JSON.stringify({
  sidebar: {
    containers: [
      { spaces: [space], items: [] },
      {
        spaces: [],
        items: [
          'F1', folder,
          'T1', tab('https://www.refero.design/x?utm_source=a', 'Refero'),
          'T2', tab('https://chatgpt.com/c/abc', 'My thread'),
          'T3', tab('https://mail.google.com/mail/u/0/#inbox', 'Inbox (3)'),
          'T4', tab('https://youtu.be/abc123?si=zz', 'Video'),
          'T5', tab('https://www.youtube.com/watch?v=abc123&utm_source=x', 'Video again'),
          'T6', tab('https://agency.example/', 'Acme Design Agency'),
        ],
      },
    ],
  },
});

test('readArcTabs reads every saved tab with its space', () => {
  const { tabs } = readArcTabs(fixture);
  assert.equal(tabs.length, 6);
  assert.deepEqual(tabs[0], { url: 'https://www.refero.design/x?utm_source=a', title: 'Refero', space: 'Work' });
});

test('readArcTabs refuses a file that is not an Arc sidebar', () => {
  assert.throws(() => readArcTabs('{"sidebar":{}}'), /no sidebar containers/);
  assert.throws(() => readArcTabs('not json'), /not valid JSON/);
});

test('canonicalUrl drops tracking and keeps the YouTube video', () => {
  assert.equal(canonicalUrl('https://www.refero.design/x?utm_source=a&ref=b#top'), 'https://refero.design/x');
  assert.equal(canonicalUrl('https://youtu.be/abc123?si=zz'), 'https://youtube.com/watch?v=abc123');
  assert.equal(canonicalUrl('https://www.youtube.com/watch?v=abc123&utm_source=x'), 'https://youtube.com/watch?v=abc123');
});

test('classifyTab keeps AI chat titles and marks them to mine later, never opened', () => {
  const chat = classifyTab('https://chatgpt.com/c/abc', 'My thread');
  assert.deepEqual(chat, { kind: 'ai-chat', why: 'ai chat thread: mine later for content and decisions', showsContent: false, provider: 'ChatGPT', mineLater: true, tags: [] });
});

test('classifyTab marks mail, search and account hosts as host-only', () => {
  assert.equal(classifyTab('https://mail.google.com/mail/u/0/#inbox', 'Inbox (3)').showsContent, false);
  assert.equal(classifyTab('https://app.example.test/anything', 'Work').kind, 'other');
});

test('classifyTab tags agency and video hosts by title and host', () => {
  assert.deepEqual(classifyTab('https://agency.example/', 'Acme Design Agency').tags, ['agency or studio site']);
  assert.equal(classifyTab('https://youtu.be/abc123', 'Video').kind, 'video');
  assert.equal(classifyTab('https://www.refero.design/x', 'Refero').kind, 'flow');
});

test('planIntake dedupes, skips held addresses and keeps titles only where they show', () => {
  const { tabs } = readArcTabs(fixture);
  const { rows, counts } = planIntake({ tabs, heldCanonicals: new Set(['https://refero.design/x']), blake3Hex, firstSeen: '2026-11-22T00:00:00+00:00' });
  assert.equal(counts.tabs, 6);
  assert.equal(counts.unique, 5);
  assert.equal(counts.held, 1);
  assert.equal(counts.new, 4);
  const byUrl = Object.fromEntries(rows.map(r => [r.canonical_url, r]));
  assert.equal(byUrl['https://chatgpt.com/c/abc'].title, 'My thread');
  assert.equal(byUrl['https://chatgpt.com/c/abc'].provider, 'ChatGPT');
  assert.equal(byUrl['https://chatgpt.com/c/abc'].mine_later, true);
  assert.equal(rows.find(r => r.site === 'mail.google.com').title, null);
  assert.equal(byUrl['https://youtube.com/watch?v=abc123'].tabs, 2);
  assert.equal(byUrl['https://agency.example'].kind, 'site');
  assert.match(byUrl['https://agency.example'].why, /agency or studio site \(from title\)/);
  assert.match(byUrl['https://youtube.com/watch?v=abc123'].id, /^record:inspiration-item:[0-9a-f]{16}$/);
});
