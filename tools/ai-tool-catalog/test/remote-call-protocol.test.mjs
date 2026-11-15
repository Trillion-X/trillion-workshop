// The installed native protocol DATA describes the existing canonical Workshop conversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROTOCOL_VERSION, toolServerSession, ToolServerNeedsSignIn } from '../do-work/talk-to-a-tool-server.mjs';

import { discoverSignIn } from '../do-work/sign-in-to-a-tool-server.mjs';

test('native protocol DATA matches the Workshop public structured conversation', async () => {
  const protocol = JSON.parse(await readFile(new URL('../read-data/remote-call-protocol.json', import.meta.url), 'utf8'));
  const requests = [];
  const post = async request => {
    const body = JSON.parse(request.body);
    requests.push({ ...request, body });
    if (body.method === protocol.hello.method) return { status: 200, headers: { [protocol.session_header]: 'synthetic-session' }, text: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { [protocol.protocol_field]: PROTOCOL_VERSION } }) };
    if (body.method === protocol.ready.method) return { status: 202, headers: {}, text: '' };
    assert.equal(body.method, protocol.call_method);
    assert.deepEqual(body.params, { [protocol.tool_field]: 'fixture', [protocol.arguments_field]: { example: true } });
    return { status: 200, headers: {}, text: `${protocol.event_data_prefix} ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { [protocol.structured_field]: { worked: true } } })}\n\n` };
  };
  const result = await toolServerSession({ url: 'https://synthetic.example.com/tools', post }).call('fixture', { example: true });
  assert.deepEqual(result, { worked: true });
  assert.deepEqual(requests[0].body, protocol.hello);
  assert.deepEqual(requests[1].body, protocol.ready);
  assert.equal(requests[2].headers[protocol.session_header], 'synthetic-session');
  assert.equal(requests[2].headers[protocol.version_header], PROTOCOL_VERSION);
  assert.equal(requests[2].headers.accept, protocol.accept);
});


test('native public challenge retains the actual selected metadata path and requested scope', async () => {
  const server = 'https://synthetic.example.com/tools';
  const path = 'https://metadata.example.com/custom/resource';
  const issuer = 'https://issuer.example.com/tenant';
  const challenge = new ToolServerNeedsSignIn(server, { resource_metadata: path, scope: 'custom.read' });
  const requests = [];
  const found = await discoverSignIn({ server, challenge, request: async url => {
    requests.push(url);
    if (url === path) return Response.json({ resource: 'https://audience.example.com/tools', authorization_servers: [issuer], scopes_supported: ['other.read'] });
    if (url === 'https://issuer.example.com/.well-known/oauth-authorization-server/tenant') return Response.json({ issuer, authorization_endpoint: 'https://authorize.example.com/start', token_endpoint: 'https://tokens.example.com/exchange', code_challenge_methods_supported: ['S256'] });
    throw new Error('unexpected metadata edge');
  } });
  assert.deepEqual(requests, [path, 'https://issuer.example.com/.well-known/oauth-authorization-server/tenant']);
  assert.equal(found.resource_metadata, path);
  assert.equal(found.scope, 'custom.read');
  assert.equal(found.resource, 'https://audience.example.com/tools');
});
