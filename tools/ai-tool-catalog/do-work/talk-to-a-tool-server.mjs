// packages/ai-tool-catalog/do-work/talk-to-a-tool-server.mjs
//
// One conversation with a remote tool server that speaks the Model Context Protocol over streamable HTTP: start it,
// read every tool it offers (all pages), and call one tool. Nothing here sends a request itself or holds a key: the
// caller hands in `post`, which may be a plain fetch or a locked box that places the person's sign-in into the
// request, so the same conversation runs for an open server and for one that needs a sign-in.
//
//   post({ url, method, headers, body }) → { status, headers, text }
//
// A reply may be one JSON message or server-sent events carrying messages; the one answering our request id is used.
// A server that wants a sign-in answers 401 with a `WWW-Authenticate` header; that answer is thrown as a
// `ToolServerNeedsSignIn` naming where the server says its sign-in is described, so the caller can start one.
//
// Invariants: a request goes only to `url`, or to a public address it redirects to (postWithFetch, http-client public-address); a tool's error (`isError`) is thrown with the tool's own words;
// a server's session id is carried on every later request, and the protocol version it agreed is sent with them.

import { fetchPublic } from '../../refuse-requests-to-private-addresses/public-address.mjs';
import protocol from '../read-data/remote-call-protocol.json' with { type: 'json' };

// This DATA also serves the native bounded HTTP adapter: one protocol owner.
export const PROTOCOL_VERSION = protocol.hello.params[protocol.protocol_field];

export class ToolServerNeedsSignIn extends Error {
  constructor(url, challenge) {
    super(`${new URL(url).host} needs a sign-in before it answers.`);
    this.name = 'ToolServerNeedsSignIn';
    this.url = url;
    this.challenge = challenge;
    this.resource_metadata = challenge && typeof challenge === 'object' ? challenge.resource_metadata ?? null : /resource_metadata="([^"]+)"/.exec(challenge ?? '')?.[1] ?? null;
    this.scope = challenge && typeof challenge === 'object' ? challenge.scope ?? null : /scope="([^"]+)"/.exec(challenge ?? '')?.[1] ?? null;
  }
}

const header = (headers, name) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;

/** The JSON-RPC messages in one reply body: a JSON message or array, or the data lines of server-sent events. */
export function messagesIn(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return [JSON.parse(trimmed)].flat();
  const messages = [];
  let data = [];
  for (const line of `${trimmed}\n\n`.split(/\r?\n/)) {
    if (line.startsWith(protocol.event_data_prefix)) data.push(line.slice(protocol.event_data_prefix.length).replace(/^ /, ''));
    else if (line === '' && data.length) { messages.push(JSON.parse(data.join('\n'))); data = []; }
  }
  return messages;
}

/** `fetch` in the shape `post` takes: only to a public address, every redirect judged again (tools/refuse-requests-to-private-addresses/public-address.mjs). */
export const postWithFetch = (request = fetch, timeoutMs = 60000) => async ({ url, method, headers, body }) => {
  const response = await fetchPublic(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(timeoutMs) }, { fetchImpl: request });
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text: await response.text() };
};

export function toolServerSession({ url, post, clientInfo = protocol.hello.params.clientInfo }) {
  let session = null;
  let agreed = null;
  let nextId = 1;
  let started = null;

  async function send(message) {
    const reply = await post({
      url, method: 'POST',
      headers: {
        'content-type': 'application/json', accept: protocol.accept,
        ...(session ? { [protocol.session_header]: session } : {}),
        ...(agreed ? { [protocol.version_header]: agreed } : {}),
      },
      body: JSON.stringify(message),
    });
    if (reply.status === 401) throw new ToolServerNeedsSignIn(url, header(reply.headers, 'www-authenticate'));
    session = header(reply.headers, protocol.session_header) ?? session;
    if (message.id === undefined) {
      if (reply.status >= 400) throw new Error(`${new URL(url).host} answered ${reply.status} to ${message.method}.`);
      return null;
    }
    let answer;
    try { answer = messagesIn(reply.text).find(item => item.id === message.id); } catch { answer = undefined; }
    if (!answer) throw new Error(`${new URL(url).host} answered ${reply.status} to ${message.method} without a reply to it: ${String(reply.text).slice(0, 200)}`);
    if (answer.error) throw new Error(`${new URL(url).host}: ${answer.error.message ?? JSON.stringify(answer.error)}`);
    return answer.result;
  }

  const request = (method, params) => send({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) });

  function start() {
    started ??= (async () => {
      const result = await request(protocol.hello.method, { ...protocol.hello.params, clientInfo });
      agreed = result?.[protocol.protocol_field] ?? PROTOCOL_VERSION;
      await send(protocol.ready);
      return result;
    })().catch(error => { started = null; throw error; });
    return started;
  }

  return {
    start,
    /** Every tool the server offers, following `nextCursor` until the last page. */
    async list() {
      await start();
      const tools = [];
      let cursor;
      for (let page = 0; page < protocol.max_pages; page += 1) {
        const result = await request(protocol.list_method, cursor ? { [protocol.cursor_field]: cursor } : undefined);
        tools.push(...(Array.isArray(result?.[protocol.tools_field]) ? result[protocol.tools_field] : []));
        cursor = result?.[protocol.next_cursor_field];
        if (!cursor) break;
      }
      return tools;
    },
    /** One tool call; the structured result when the tool gives one, otherwise its content. */
    async call(name, args) {
      await start();
      const result = await request(protocol.call_method, { [protocol.tool_field]: name, [protocol.arguments_field]: args ?? {} });
      const content = result?.[protocol.content_field];
      const words = (content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
      if (result?.[protocol.error_field]) throw new Error(`${name} answered with an error: ${words.slice(0, 500) || 'no words given'}`);
      return result?.[protocol.structured_field] ?? (content?.length === 1 && content[0].type === 'text' ? parsedOrText(content[0].text) : content ?? null);
    },
  };
}

function parsedOrText(text) {
  try { return JSON.parse(text); } catch { return text; }
}
