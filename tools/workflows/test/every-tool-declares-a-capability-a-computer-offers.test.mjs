// A tool row of invoke kind `computer` names the capabilities it needs (invoke.capabilities). A capability no computer reports
// refuses the run before it starts ("This computer does not offer ..."), so a row may only name an id the engine's capability
// list holds (crates/computer-sandbox-sbpl/computer-capabilities.json in the engine's repository, the owner of the list). Nov 21 2026,
// 6:08 AM CST: tool:send-a-message-on-this-mac named use-the-messages-app, which no computer offers, and the one text it was
// to send went nowhere; four hold-a-computer-quiet rows named close-apps-and-switch-focus, which the engine renamed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The engine's list lives in the engine's own repository, and a push gate runs in a temporary checkout, so the list is found
// by ENGINE_CAPABILITIES_FILE, else in whichever checkout under this Mac's dev folder holds it. Where none does (a clone of this
// repository alone) the test is skipped, and says so.
const LISTED = 'crates/computer-sandbox-sbpl/computer-capabilities.json';
const DEV = join(homedir(), 'dev');
const beside = () => (existsSync(DEV) ? readdirSync(DEV).map(folder => join(DEV, folder, LISTED)) : []);
const LIST = [process.env.ENGINE_CAPABILITIES_FILE, ...beside()].find(path => path && existsSync(path));
const TOOLS = new URL('../../', import.meta.url);

test('every capability a tool row declares is one the engine reports', { skip: LIST ? false : "the engine's computer-capabilities.json is not here; set ENGINE_CAPABILITIES_FILE to it" }, () => {
  const offered = new Set(JSON.parse(readFileSync(LIST, 'utf8')).capabilities.map(capability => capability.id));
  const refused = [];
  for (const folder of readdirSync(TOOLS, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const file = new URL(`${folder.name}/what-this-tool-does-and-how-to-run-it.json`, TOOLS);
    if (!existsSync(file)) continue;
    for (const { payload } of JSON.parse(readFileSync(file, 'utf8')).records ?? []) {
      for (const capability of payload?.invoke?.capabilities ?? []) {
        if (!offered.has(capability)) refused.push(`${payload.id} declares ${capability}`);
      }
    }
  }
  assert.deepEqual(refused, [], `No computer offers these capabilities, so these tools cannot run:\n${refused.join('\n')}`);
});
