// tools/register-trillion-in-my-ai-apps/do-work/local-door.mjs
//
// Moved from Trillion-X/trillion harness/local-door.mjs.
//
// The account's MCP door on this computer: the loopback port the Mac app's local runtime serves. It is read at every
// call from the app that runs this program, so no address or port is copied into an AI app's config, a setting or
// source, and a runtime started again on another port is followed. The app's sealed declaration
// (Contents/Resources/computer-reader.json `local_runtime.adoption_file`) names its private adoption descriptor under
// Application Support; the descriptor's `port` is the one the app starts its runtime on.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const readText = file => readFileSync(file, 'utf8');

/** The app bundle's Contents folder holding `runtime` (its own node, Contents/MacOS/node). */
const contentsOf = runtime => dirname(dirname(runtime));

/** The door's MCP address, http://127.0.0.1:<port>/mcp. */
export function localDoorAddress({ runtime = process.execPath, home = os.homedir(), read = readText } = {}) {
  let name;
  try { name = JSON.parse(read(join(contentsOf(runtime), 'Resources', 'computer-reader.json'))).local_runtime?.adoption_file; }
  catch { name = undefined; }
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.split('/').includes('..')) {
    throw new Error('Run this with the node inside the installed Mac app, which names its local door.');
  }
  let port;
  try { ({ port } = JSON.parse(read(join(home, 'Library', 'Application Support', name)))); }
  catch { port = undefined; }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The Mac app has no local door set up on this computer.');
  return `http://127.0.0.1:${port}/mcp`;
}
