import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDoorAddress } from 'trillion-workshop/tools/keep-and-wake-ai-sessions-on-this-computer/harness/local-door.mjs';
import { runBridge } from 'trillion-workshop/tools/keep-and-wake-ai-sessions-on-this-computer/harness/keychain-mcp-bridge.mjs';
import { PassThrough } from 'node:stream';

const bridge = fileURLToPath(new URL(import.meta.resolve('trillion-workshop/tools/keep-and-wake-ai-sessions-on-this-computer/harness/keychain-mcp-bridge.mjs')));
const start = address => spawnSync(process.execPath, [bridge, address], { input: '', encoding: 'utf8', timeout: 10_000 });
test('the bridge never sends the account key in the clear over a network, and refuses before reading it', () => {
  for (const address of ['http://example.com/mcp', 'http://127.0.0.1.example.com/mcp', 'https://person:secret@example.com/mcp', 'ftp://127.0.0.1/mcp']) {
    const ran = start(address);
    assert.notEqual(ran.status, 0, address);
    assert.match(ran.stderr, /Name the MCP address: https, or http to this computer's loopback address/, address);
  }
});
