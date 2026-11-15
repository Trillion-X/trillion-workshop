// Reads the Markdown conversation export produced by ChatGPT's individual-chat export.
// Body words are sliced without rewriting; source spans also retain export metadata and separators.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function markdownChatExport(text) {
  if (typeof text !== 'string') throw new Error('A Markdown chat export must be text.');
  const lines = text.split(/(?<=\n)/);
  const title = lines[0]?.replace(/\r?\n$/, '').match(/^#\s+(.+?)\s*$/)?.[1];
  const header = lines.slice(1, 8).join('').match(new RegExp(`\\*\\*Link:\\*\\*\\s*\\[https?://chatgpt\\.com/c/(${UUID})\\]\\(https?://chatgpt\\.com/c/\\1\\)`, 'i'));
  if (!title || !header) throw new Error('Unsupported Markdown chat export: expected a title and a ChatGPT /c/<UUID> link.');
  const boundaries = [];
  let fence = null;
  let offset = 0;
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, '');
    const marker = bare.match(/^\s{0,3}(```+|~~~+)/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length
        && /^\s{0,3}(```+|~~~+)\s*$/.test(bare)) fence = null;
    } else if (!fence) {
      const heading = bare.match(/^##\s+(Prompt|Response):\s*$/i);
      if (heading) boundaries.push({ offset, role: heading[1].toLowerCase() === 'prompt' ? 'person' : 'ai' });
    }
    offset += line.length;
  }
  if (!boundaries.length) throw new Error('Unsupported Markdown chat export: no Prompt or Response occurrences were found.');
  // Locate the first actual occurrence and keep all subsequent occurrence bodies, including adjacent same-role rows.
  const spans = [];
  const metadata = [];
  const messages = boundaries.map((boundary, index) => {
    const next = boundaries[index + 1];
    let start = boundary.offset;
    const headingEnd = text.indexOf('\n', start);
    if (headingEnd < 0) throw new Error('Corrupt Markdown chat export: a message heading has no body.');
    start = headingEnd + 1;
    let end = next ? next.offset : text.length;
    while (end > start && text[end - 1] === '\n') end -= text[end - 2] === '\r' ? 2 : 1;
    const rawBody = text.slice(start, end);
    // Export metadata is the first nonempty line after the heading: a local timestamp, optionally followed by model.
    const stamp = rawBody.match(/^(\r?\n)*([^\r\n]+)(\r?\n+)/);
    const metaLine = stamp?.[2]?.match(/^\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M(?:\s+·\s+(.+))?$/i);
    const body = metaLine ? rawBody.slice(stamp[0].length) : rawBody;
    if (!body.length) throw new Error(`Corrupt Markdown chat export: occurrence ${index + 1} has an empty body.`);
    spans.push({ unit: 'utf16-code-unit', start: boundary.offset, end: next ? next.offset : text.length,
      body_start: start + (metaLine ? stamp[0].length : 0), body_end: end });
    metadata.push({ source_at: metaLine ? stamp[2].split(' · ')[0] : null, model: metaLine?.[1] ?? null });
    return { id: `markdown:${header[1]}:${index + 1}`, speaker: boundary.role, text: body, at: null, model: metaLine?.[1] ?? null, source_at: metaLine ? stamp[2].split(' · ')[0] : null };
  });
  return { conversation_id: header[1], title, messages, provenance: { unit: 'utf16-code-unit', header_span: { start: 0, end: boundaries[0].offset }, source_spans: spans, occurrences: metadata } };
}

export function isMarkdownChatExport(text) {
  return typeof text === 'string' && /^#\s+.+\r?\n/.test(text) && new RegExp(`\\*\\*Link:\\*\\*\\s*\\[https?://chatgpt\\.com/c/${UUID}\\]\\(https?://chatgpt\\.com/c/${UUID}\\)`, 'i').test(text.slice(0, 2000));
}
