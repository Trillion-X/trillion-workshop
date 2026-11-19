// Save this chat (extension/src/read-conversation.mjs over extension/conversation-sites.json, then bring_in_chat):
// the one reader, run in a real Chromium on saved sample pages of ChatGPT (the older page, the signed-in Chat/Work page
// as recorded in September 2026, and a shared chat), Gemini and WhatsApp, reads each open conversation from that
// site's DATA row alone, and reads older messages the page has not loaded yet without the person scrolling; the account keeps a conversation read off its page word for word
// (src/chat-archives.mjs), and saving the same chat again, even hours later with no times on the page, adds only what
// is new (src/messages.mjs source_ref). Every person and chat here is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { launchChromium } from 'trillion-workshop/tools/headless-browser/test/workshop-browser-for-tests.mjs';
import { progressKey, readConversation, siteFor } from '../src/read-conversation.mjs';
import sites from '../conversation-sites.json' with { type: 'json' };
import { lazyChat } from './web-conversations/lazy-chat.mjs';
import { conversationFrom } from 'trillion-workshop/tools/conversations/read-data/chat-archives.mjs';
import { messages } from 'trillion-workshop/tools/keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';
import { localStore } from 'trillion-workshop/tools/keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { importConversation, ownerRecords } from 'trillion-workshop/tools/conversations/read-data/chat-import.mjs';
import { answering } from 'trillion-workshop/tools/conversations/read-data/rows-in-hand.mjs';
import { heldStore, runKept } from 'trillion-workshop/tools/conversations/test/support/held-store.mjs';

const site = id => sites.sites.find(row => row.id === id);
const fixture = name => readFile(new URL(`./web-conversations/${name}.html`, import.meta.url), 'utf8');

test('a page is read by the row for its site, and only a page with a conversation open', () => {
  assert.equal(siteFor('https://chatgpt.com/c/6717f0aa-0c1e-8008-9e3b-4d1f2a7b9c01', sites.sites)?.id, 'chatgpt');
  assert.equal(siteFor('https://chatgpt.com/g/g-abc-kiln/c/6717f0aa', sites.sites)?.id, 'chatgpt');
  assert.equal(siteFor('https://chatgpt.com/share/6717f0aa-0c1e-8008-9e3b-4d1f2a7b9c01', sites.sites)?.id, 'chatgpt', 'a shared chat is read too');
  assert.equal(siteFor('https://chatgpt.com/', sites.sites), null, 'a new chat has nothing to save yet');
  assert.equal(siteFor('https://gemini.google.com/app/7c1d2e3f4a5b', sites.sites)?.id, 'gemini');
  assert.equal(siteFor('https://web.whatsapp.com/', sites.sites)?.id, 'whatsapp');
  assert.equal(siteFor('https://example.com/c/123', sites.sites), null);
  assert.equal(siteFor('not an address', sites.sites), null);
});

async function readIn(browser, address, name, row) {
  const page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC' });
  const html = await fixture(name);
  await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(address);
  const read = await page.evaluate(readConversation, row);
  await page.close();
  return read;
}

test('one reader reads ChatGPT, Gemini and WhatsApp pages from their rows alone', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const chatgpt = await readIn(browser, 'https://chatgpt.com/c/6717f0aa-0c1e-8008-9e3b-4d1f2a7b9c01', 'chatgpt', site('chatgpt'));
    assert.deepEqual(chatgpt, {
      app: 'ChatGPT', conversation_id: '6717f0aa-0c1e-8008-9e3b-4d1f2a7b9c01', title: 'Glaze test tiles',
      messages: [
        { id: 'aaa-user-1', speaker: 'person', text: 'Why did this glaze crawl?\nIt was the second firing.' },
        { id: 'bbb-ai-1', speaker: 'ai', text: 'Most likely it went on too thick over dust.\nWipe the bisque.\nThin the coat.\npython\nthickness = 0.5', model: 'gpt-5' },
        { id: 'ddd-user-2', speaker: 'person', text: 'Thanks 🙏' },
      ],
    }, 'the system note is left out: its speaker is not in the row\'s map');

    const gemini = await readIn(browser, 'https://gemini.google.com/app/7c1d2e3f4a5b', 'gemini', site('gemini'));
    assert.deepEqual(gemini, {
      app: 'Gemini', conversation_id: '7c1d2e3f4a5b', title: 'Trip to Lisbon',
      messages: [
        { id: 'r_1a2b3c:person', speaker: 'person', text: 'Plan two days in Lisbon\non foot' },
        { id: 'r_1a2b3c:ai', speaker: 'ai', text: 'Day one: Alfama and the castle.\nDay two: Belém.' },
        { id: 'r_4d5e6f:person', speaker: 'person', text: 'Where to eat?' },
        { id: 'r_4d5e6f:ai', speaker: 'ai', text: 'Try a tasca near the river.' },
      ],
    });

    const whatsapp = await readIn(browser, 'https://web.whatsapp.com/', 'whatsapp', site('whatsapp'));
    assert.deepEqual(whatsapp, {
      app: 'WhatsApp', conversation_id: '120363000000000001-g@example.com', title: 'Kiln club',
      messages: [
        { id: 'false_120363000000000001-g@example.com_3EB0AAA1_15550001111-c@example.com', speaker: 'Ana', text: 'Firing tonight at 8 🔥', at: '2026-09-28T09:05:00.000Z' },
        { id: 'true_120363000000000001-g@example.com_3EB0BBB2', speaker: 'person', text: "I'll bring the tiles", at: '2026-09-28T09:07:00.000Z' },
        { id: 'false_120363000000000001-g@example.com_3EB0CCC3_15550002222-c@example.com', speaker: 'Ben', text: 'Cone 6?\nOr 5', at: '2026-09-28T13:30:00.000Z' },
      ],
    }, 'a deleted message has no words and is left out; the sidebar is not the chat');

    const empty = await readIn(browser, 'https://chatgpt.com/c/nothing-here', 'gemini', site('chatgpt'));
    assert.deepEqual(empty, { app: 'ChatGPT', problem: 'no-messages' });
    const noChat = await readIn(browser, 'https://web.whatsapp.com/', 'gemini', site('whatsapp'));
    assert.deepEqual(noChat, { app: 'WhatsApp', problem: 'no-conversation' });
  } finally {
    await browser.close();
  }
});

test('ChatGPT\'s row reads the page as ChatGPT draws it now: the signed-in Chat/Work page, with either marker, and a shared chat', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    const expected = {
      app: 'ChatGPT', conversation_id: '00000000-0000-4000-8000-00000000c0de', title: 'Reply with OK',
      messages: [
        { id: '11111111-1111-4111-8111-111111111111', speaker: 'person', text: 'Reply with exactly: OK' },
        { id: '22222222-2222-4222-8222-222222222222', speaker: 'ai', text: 'OK' },
      ],
    };
    assert.deepEqual(await readIn(browser, 'https://chatgpt.com/c/00000000-0000-4000-8000-00000000c0de', 'chatgpt-chat-work', site('chatgpt')), expected,
      'the sign-in page names each message only by its search keys; "You said:", "ChatGPT said:", "Worked for 12s" and the buttons are not words of a message');
    // ChatGPT draws some pages with only one of its two marker families.
    for (const omitted of ['data-chatgpt-search-unit-key', 'data-content-search-unit-key']) {
      const page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC' });
      const html = await fixture('chatgpt-chat-work');
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
      await page.goto('https://chatgpt.com/c/00000000-0000-4000-8000-00000000c0de');
      await page.evaluate(name => document.querySelectorAll(`[${name}]`).forEach(node => node.removeAttribute(name)), omitted);
      assert.deepEqual(await page.evaluate(readConversation, site('chatgpt')), expected, `read without ${omitted}`);
      await page.close();
    }
    assert.deepEqual(await readIn(browser, 'https://chatgpt.com/share/5a1e0c00-0000-4000-8000-00000000c0de', 'chatgpt-share', site('chatgpt')), {
      app: 'ChatGPT', conversation_id: '5a1e0c00-0000-4000-8000-00000000c0de', title: 'Kiln shelf wash',
      messages: [
        { id: '5a1e0c11-1111-4a11-8a11-000000000001', speaker: 'person', text: 'Which kiln shelf wash lasts longest?' },
        { id: '5a1e0c22-2222-4a22-8a22-000000000002', speaker: 'ai', text: 'Alumina and kaolin, half and half, lasts longest.\nRecoat when it flakes.', model: 'gpt-5-6-thinking' },
      ],
    });
  } finally {
    await browser.close();
  }
});


test('WhatsApp\'s older messages are read without the person scrolling, and the chat is left where it was', { timeout: 120000 }, async () => {
  const browser = await launchChromium();
  try {
    for (const shape of [{}, { reverse: true }, { dropsFar: true }]) {
      const page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC' });
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: lazyChat(shape) }));
      await page.goto('https://web.whatsapp.com/');
      const lastAt = () => page.evaluate(() => document.querySelector('[data-id*="_M119_"]')?.getBoundingClientRect().top ?? null);
      const before = await lastAt();
      const reading = page.evaluate(`(${readConversation})(${JSON.stringify(site('whatsapp'))}, ${JSON.stringify(progressKey)})`);
      const seen = new Set();
      let done = false;
      reading.finally(() => { done = true; });
      while (!done) {
        seen.add(await page.evaluate(key => globalThis[key]?.messages ?? 0, progressKey));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const read = await reading;
      assert.equal(read.conversation_id, '120363000000000001-g@example.com');
      assert.deepEqual(read.messages.map(message => message.text), Array.from({ length: 120 }, (_, n) => `Message ${n}`), `every message, oldest first (${JSON.stringify(shape)})`);
      assert.equal(new Set(read.messages.map(message => message.id)).size, 120);
      assert.ok([...seen].some(count => count > 20 && count < 120), `the count read so far is shown while reading (${[...seen].join(', ')})`);
      assert.equal(await page.evaluate(key => globalThis[key].messages, progressKey), 120);
      if (!shape.dropsFar) assert.equal(await lastAt(), before, 'the chat is scrolled back to the message the person was looking at');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('a site read by a row nobody wrote code for is read the same way', { timeout: 60000 }, async () => {
  const row = { id: 'made-up', app: 'Made Up Chat', hosts: ['chat.example'], conversation_path: '^/t/([a-z0-9]+)',
    conversation_id: [{ value_from: 'path' }], title: [{ select: 'h1' }],
    messages: [{ select: 'li.said', id: [{ attribute: 'data-n' }], speaker: [{ attribute: 'data-who', map: { me: 'person', bot: 'ai' } }, { attribute: 'data-who' }], text: [{}], at: [{ select: 'time', attribute: 'datetime' }], skip: 'time' }] };
  assert.equal(siteFor('https://chat.example/t/abc', [row])?.id, 'made-up');
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: [
      '<h1>Picnic</h1><ul>',
      '<li class="said" data-n="1" data-who="me">Bring <b>bread</b><time datetime="2026-09-01T10:00:00Z">10:00</time></li>',
      '<li class="said" data-n="2" data-who="Sam">And cheese</li>',
      '<li class="said" data-n="3" data-who="bot">Noted.</li></ul>'].join('') }));
    await page.goto('https://chat.example/t/abc');
    assert.deepEqual(await page.evaluate(readConversation, row), { app: 'Made Up Chat', conversation_id: 'abc', title: 'Picnic', messages: [
      { id: '1', speaker: 'person', text: 'Bring bread', at: '2026-09-01T10:00:00.000Z' },
      { id: '2', speaker: 'Sam', text: 'And cheese' },
      { id: '3', speaker: 'ai', text: 'Noted.' },
    ] });
  } finally {
    await browser.close();
  }
});

test('a conversation read off its page is kept word for word, each message by its place on the page', () => {
  const chat = conversationFrom({ conversation_id: 'c1', title: 'Kiln club', messages: [
    { id: 'm1', speaker: 'Ana', text: 'Firing tonight', at: '2026-09-28T09:05:00Z' },
    { id: 'm2', speaker: 'person', text: '  keep my spaces  ' },
    { id: 'm3', speaker: 'ai', text: 'Noted', model: 'gpt-5' },
  ] }, 'WhatsApp');
  assert.deepEqual(chat, { conversation_id: 'c1', title: 'Kiln club', app: 'WhatsApp', messages: [
    // The page's own words for the time are kept beside the time read from them (test/chat-source-time.test.mjs).
    { node: 'm1', speaker: 'Ana', text: 'Firing tonight', at: '2026-09-28T09:05:00.000Z', source_at: '2026-09-28T09:05:00Z', model: null, attachments: [] },
    { node: 'm2', speaker: 'person', text: '  keep my spaces  ', at: null, model: null, attachments: [] },
    { node: 'm3', speaker: 'ai', text: 'Noted', at: null, model: 'gpt-5', attachments: [] },
  ] });
  assert.throws(() => conversationFrom({ messages: [] }), /conversation_id/);
  assert.throws(() => conversationFrom({ conversation_id: 'c', messages: [{ id: 'a', speaker: 'ai', text: 'x' }, { id: 'a', speaker: 'ai', text: 'y' }] }), /own id/);
  assert.throws(() => conversationFrom({ conversation_id: 'c', messages: [{ id: 'a', speaker: 'ai', text: 'x', at: 'yesterday' }] }), /date and time/);
  assert.throws(() => conversationFrom({ title: 'no mapping' }), /mapping/);
});

// A real record store, so messages() reads kept fields the way the person's store does.
const memoryStore = () => localStore(':memory:').eeaf;

test('a message that names its place in its conversation is kept once, however much later it is saved again', () => {
  const store = memoryStore();
  let clock = new Date('2026-09-29T10:00:00Z');
  const kept = messages(store, { now: () => clock });
  const batch = { messages: [
    { conversation_id: 'ChatGPT:c1', app: 'ChatGPT', speaker: 'person', text: 'Why did it crawl?', source_ref: 'aaa' },
    { conversation_id: 'ChatGPT:c1', app: 'ChatGPT', speaker: 'ai', text: 'Too thick.', source_ref: 'bbb' },
  ] };
  const first = kept.record(batch);
  assert.equal(first.recorded, 2);
  clock = new Date('2026-09-29T15:00:00Z');
  const again = kept.record({ messages: [...batch.messages, { conversation_id: 'ChatGPT:c1', app: 'ChatGPT', speaker: 'person', text: 'Thanks', source_ref: 'ccc' }] });
  assert.equal(again.recorded, 1, 'five hours later only the new message is added');
  assert.deepEqual(again.ids.slice(0, 2), first.ids);
  assert.equal(store.ids('message').length, 3);
  // The same place in another app's conversation is another message.
  assert.equal(kept.record({ messages: [{ ...batch.messages[0], app: 'Gemini', conversation_id: 'Gemini:c1' }] }).recorded, 1);
  // A message kept before it named its place (an export brought in earlier, with its time) is found and named.
  const older = kept.record({ messages: [{ conversation_id: 'ChatGPT:c2', app: 'ChatGPT', speaker: 'ai', text: 'Hi', at: '2026-01-01T00:00:00Z' }] });
  const named = kept.record({ messages: [{ conversation_id: 'ChatGPT:c2', app: 'ChatGPT', speaker: 'ai', text: 'Hi', at: '2026-01-01T00:00:00Z', source_ref: 'n1' }] });
  assert.equal(named.recorded, 0);
  assert.deepEqual(named.ids, older.ids);
  clock = new Date('2026-09-30T15:00:00Z');
  assert.equal(kept.record({ messages: [{ conversation_id: 'ChatGPT:c2', app: 'ChatGPT', speaker: 'ai', text: 'Hi', source_ref: 'n1' }] }).recorded, 0);
  assert.throws(() => kept.record({ messages: [{ ...batch.messages[0], source_ref: '' }] }), /source_ref/);
});

// The conversation importer is handed the person's rows it asks for and answers what it keeps; the test plays the
// person's store (tools/conversations/test/support/held-store.mjs), handing rows in and writing each keep back.
test('saving a chat from its page twice keeps its messages once in the private Trillion', async () => {
  const store = heldStore();
  const now = () => new Date('2026-09-29T10:00:00Z');
  const save = conversation => runKept(store, (request, context) => answering(request, context, hand =>
    importConversation({ conversation, app: 'ChatGPT' }, { hand, eeaf: ownerRecords(hand), now })), {}).then(done => done.answer);
  const page = { conversation_id: '6717f0aa', title: 'Glaze test tiles', messages: [
    { id: 'aaa-user-1', speaker: 'person', text: 'Why did this glaze crawl?' },
    { id: 'bbb-ai-1', speaker: 'ai', text: 'Too thick over dust.', model: 'gpt-5' },
  ] };
  const first = await save(page);
  assert.deepEqual({ added: first.added, already: first.already_there, into: first.into }, { added: 2, already: 0, into: 'private' });
  assert.ok(first.keep.every(item => 'expected' in item), 'every write carries the record it expected');
  const second = await save({ ...page, messages: [...page.messages, { id: 'ccc-user-2', speaker: 'person', text: 'Thanks' }] });
  assert.deepEqual({ added: second.added, already: second.already_there }, { added: 1, already: 2 });
  const read = store.rowsOf('message').filter(record => record.value.conversation_id === 'ChatGPT:6717f0aa').map(record => record.value);
  assert.deepEqual(read.map(message => [message.speaker, message.text, message.source_ref]).sort((a, b) => a[2].localeCompare(b[2])), [
    ['person', 'Why did this glaze crawl?', 'aaa-user-1'], ['ai', 'Too thick over dust.', 'bbb-ai-1'], ['person', 'Thanks', 'ccc-user-2'],
  ]);
  assert.equal(read.find(message => message.source_ref === 'bbb-ai-1').model, 'gpt-5');
});
