import test from 'node:test';
import assert from 'node:assert/strict';
import { aiAppGuides } from '../read-data/ai-app-guides.mjs';

test('the declared Muse connector words use the reached origin and host alongside its MCP address', () => {
  for (const origin of ['https://door.example.test', 'https://another.example.test:9443']) {
    const guide = aiAppGuides(origin).tabs.find(tab => tab.id === 'chat');
    const words = JSON.stringify(guide.steps);
    assert.doesNotMatch(words, /\{(?:origin|host|mcp)\}/);
    const code = guide.steps.find(step => step.title === 'Paste this message into Muse').code;
    assert.ok(code.includes(`domain ${new URL(origin).host};`));
    assert.ok(code.includes(`the authorization_endpoint and the token_endpoint that ${origin}/.well-known/oauth-authorization-server names`), 'the addresses come from the server\'s own discovery document');
    assert.doesNotMatch(code, /\/oauth\/token|\/authorize;/);
    assert.ok(code.includes(`Trillion's MCP server is ${origin}/mcp.`));
    assert.ok(code.includes('client_id muse;'));
    assert.ok(code.includes('redirect_uri https://agent.meta.ai/api/hatch/oauth/callback;'));
  }
});

test('install substitutions cannot replace the reached origin or host in connector words', () => {
  const guide = aiAppGuides('https://door.example.test', { origin: 'https://different.example.test', host: 'different.example.test' });
  const steps = JSON.stringify(guide.tabs.find(tab => tab.id === 'chat').steps);
  assert.ok(steps.includes('domain door.example.test;'));
  assert.ok(!steps.includes('different.example.test'));
});
