// src/reply.mjs
//
// Purpose: the JSON object in a model's reply. A reply is a chat-completions answer as the service gave it (its text),
// or the reply itself when it already is an object. Ported from src/awareness.mjs (replyObject, NotJson) of the old
// repository (commit b6ae0ebf8). A reply with no JSON object in it is NotJson, which the reader asks to be made valid once.

export class NotJson extends Error {}

/** A model's reply value: the message text of a chat-completions reply, `response`, `content`, or the reply itself. */
export function replyValue(reply) {
  return reply?.choices?.[0]?.message?.content ?? reply?.response ?? (typeof reply?.content === 'string' ? reply.content : reply);
}

/** The words of a reply, as text. */
export function replyText(reply) {
  const value = replyValue(reply);
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

/** The JSON object in a model's reply (or the reply itself when it already is one). Throws NotJson when there is none. */
export function replyObject(reply) {
  const value = replyValue(reply);
  if (value && typeof value === 'object') return value;
  const said = String(value ?? '');
  const start = said.indexOf('{');
  const end = said.lastIndexOf('}');
  if (start === -1 || end <= start) throw new NotJson('The reading came back without JSON, so the picture was kept as it was.');
  return JSON.parse(said.slice(start, end + 1));
}
