import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationFrom } from '../read-data/chat-archives.mjs';
import { exportedConversations } from '../read-data/chat-import.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const fixture = `# Sample chat\n\n**Link:** [https://chatgpt.com/c/${id}](https://chatgpt.com/c/${id})  \n\n## Prompt:\n\n11/5/2026, 8:21:54 AM\n\nFirst exact words.\n\n## Response:\n\n11/5/2026, 8:21:55 AM · GPT-5\n\nSame answer.\n\n## Response:\n\n11/5/2026, 8:21:56 AM · GPT-5\n\nSame answer.\n\n## Prompt:\n\n11/5/2026, 8:21:57 AM\n\nFence test:\n\n\`\`\`md\n## Response:\nThis stays in the body.\n\`\`\`\nend.`;

test('reads Markdown export occurrences without alternating or treating fenced headings as messages', () => {
  const [archive] = exportedConversations(Buffer.from(fixture));
  const chat = conversationFrom(archive);
  assert.equal(chat.conversation_id, id);
  assert.equal(chat.title, 'Sample chat');
  assert.deepEqual(chat.messages.map(message => [message.speaker, message.text]), [
    ['person', 'First exact words.'], ['ai', 'Same answer.'], ['ai', 'Same answer.'],
    ['person', 'Fence test:\n\n```md\n## Response:\nThis stays in the body.\n```\nend.'],
  ]);
  assert.equal(new Set(chat.messages.map(message => message.node)).size, 4);
  assert.equal(chat.messages[0].source_at, '11/5/2026, 8:21:54 AM');
  assert.equal(chat.messages[1].model, 'GPT-5');
  assert.equal(archive.provenance.source_spans.length, 4);
  archive.provenance.source_spans.forEach((span, index) => assert.equal(fixture.slice(span.body_start, span.body_end), archive.messages[index].text));
  const spans = [archive.provenance.header_span, ...archive.provenance.source_spans];
  assert.equal(spans.map(span => fixture.slice(span.start, span.end)).join(''), fixture, 'raw spans reconstruct the entire source exactly');
  assert.equal(chat.messages[0].at, null, 'a local timestamp without a zone is not converted to UTC');
});

test('rejects malformed or identity-free Markdown exports', () => {
  assert.throws(() => exportedConversations(Buffer.from('# Chat\n\n## Prompt:\nhi')), /not JSON or a supported Markdown/);
  assert.throws(() => exportedConversations(Buffer.from(`# Chat\n\n**Link:** [https://chatgpt.com/c/${id}](https://chatgpt.com/c/${id})\n`)), /no Prompt or Response/);
});

test('keeps a final one-character line and code fence content that is not a closing fence', () => {
  const prefix = `# Chat\n\n**Link:** [https://chatgpt.com/c/${id}](https://chatgpt.com/c/${id})\n\n## Prompt:\n\n11/5/2026, 8:21:54 AM\n\n`;
  const body = '```md\n```not-a-closing-fence\n## Response:\ninside code\n```\nX';
  const [archive] = exportedConversations(Buffer.from(prefix + body));
  assert.equal(archive.messages.length, 1);
  assert.equal(archive.messages[0].text, body);
  const [oneLetter] = exportedConversations(Buffer.from(prefix + 'X'));
  assert.equal(oneLetter.messages[0].text, 'X');
});
