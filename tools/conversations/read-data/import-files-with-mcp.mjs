// Native-host entry for the same owner when the configured Workshop runner is unavailable.
// The existing MCP bridge owns credentials; stdin names existing account exports only.
import { readFileSync } from 'node:fs';
import { exportedConversations, importNamespaceExports } from './chat-import.mjs';
import { conversationFrom } from './chat-archives.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { openStdioRecordsDoor } from '../../records-door/read-data/stdio-mcp-door.mjs';
import { sourceKeyOfMessage } from '../../keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
if (process.argv[2] === '--source-key') {
  console.log(sourceKeyOfMessage(input));
  process.exit(0);
}
if (process.argv[2] === '--inspect-source') {
  const files = input.files.map(file => {
    const bytes = readFileSync(file), text = bytes.toString('utf8');
    const [archive] = exportedConversations(bytes), chat = conversationFrom(archive, 'ChatGPT', { most_text: 16000 });
    const spans = archive.provenance && [archive.provenance.header_span, ...archive.provenance.source_spans];
    if (spans && spans.map(span => text.slice(span.start, span.end)).join('') !== text) throw new Error('Source span reconstruction differs.');
    return { file, identity: makeHashCodeHexFromBytes(bytes), bytes: bytes.length, conversation_id: chat.conversation_id,
      occurrences: archive.messages.length, person: archive.messages.filter(m => m.speaker === 'person').length,
      ai: archive.messages.filter(m => m.speaker === 'ai').length, kept_parts: chat.messages.length, spans_exact: Boolean(spans) };
  });
  console.log(JSON.stringify({ files })); process.exit(0);
}
const door = openStdioRecordsDoor({ argv: process.argv.slice(2), files_resource: '@namespace', timeout_ms: 60000 });
try {
  const result = await importNamespaceExports({ input }, { door });
  const checked = result.files.flatMap(file => file.conversations ?? []);
  console.log(JSON.stringify({ done: result.done, more: result.more, messages_added: result.messages_added,
    messages_already_kept: result.messages_already_kept, files: result.files.map(({ name, identity, done, skipped }) => ({ name, identity, done, skipped })), checked }));
} finally { await door.close(); }
