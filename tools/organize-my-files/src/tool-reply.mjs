// A tool's answer can carry MCP content blocks besides its JSON (a picture as an `image` block, a `resource_link` to
// a file): `withContent(value, blocks)` returns the value with the blocks attached under CONTENT, a symbol, so they are
// never part of the JSON the AI reads as text or as structuredContent. handleMcpMessage (src/tools.mjs) appends them
// after the text block.
export const CONTENT = Symbol('mcp content blocks');

export const withContent = (value, blocks) => Object.assign({ ...value }, { [CONTENT]: blocks.filter(Boolean) });

// What only the view an AI app draws for the tool reads (the reply's `_meta`, which the app hands the view and never
// the AI): `withViewData(value, data)` attaches it under VIEW_DATA, a symbol, the same way.
export const VIEW_DATA = Symbol('data for the tool view');

export const withViewData = (value, data) => (data ? Object.assign({ ...value }, { [VIEW_DATA]: data }) : value);

// The text block of a reply for a view alone (a tool the app keeps from the AI) need not repeat its JSON: the view
// reads structuredContent. `withSaid(value, text)` attaches the one line the text block says instead, under SAID.
export const SAID = Symbol('the text block of the reply');

export const withSaid = (value, text) => Object.assign({ ...value }, { [SAID]: text });

// One more field on a successful tools/call reply, as its own text block (the tool's own JSON stays as it was) and in
// structuredContent: what the AI should also know, such as notices it has not seen (src/worker.mjs).
export function alsoSay(reply, field, value) {
  const result = reply?.result;
  if (!result?.content || result.isError) return reply;
  const structured = result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent) ? result.structuredContent : {};
  return { ...reply, result: { ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ [field]: value }, null, 2) }], structuredContent: { ...structured, [field]: value } } };
}
