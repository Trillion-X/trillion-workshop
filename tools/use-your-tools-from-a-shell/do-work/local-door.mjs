// tools/use-your-tools-from-a-shell/do-work/local-door.mjs
//
// Moved from an older repository (moved-from.json names where).
//
// The MCP door on this computer: the loopback address the Mac app's engine (`serve CONFIG`) serves at,
// `http://127.0.0.1:<port>/mcp`. It is read at every call from the app that runs this program, so no address or port is
// copied into an AI app's config, a setting or source, and an engine started again on another port is followed. The app's
// sealed declaration (Contents/Resources/computer-reader.json `local_runtime.computer`) names the loopback host
// (`listen_host`) and the port (`port`). Who calls the door is the engine's own check of a pass the sign-in tool signed:
// this file only finds it. The engine admits its own loopback address as Host, so a local AI goes straight in, with no
// round trip over the internet. The declaration's `public_origin` is the origin the engine serves (`localDoorOrigin`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const readText = file => readFileSync(file, 'utf8');

/** The app bundle's Contents folder holding `runtime` (its own node, Contents/MacOS/node). */
const contentsOf = runtime => dirname(dirname(runtime));

/** The door's MCP address, http://127.0.0.1:<port>/mcp. */
export function localDoorAddress({ runtime = process.execPath, read = readText } = {}) {
  let computer;
  try { computer = JSON.parse(read(join(contentsOf(runtime), 'Resources', 'computer-reader.json'))).local_runtime?.computer; }
  catch { computer = undefined; }
  const { port, listen_host: host } = computer ?? {};
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || host !== '127.0.0.1') throw new Error('Run this with the node inside the installed Mac app, which names its local door.');
  return `http://${host}:${port}/mcp`;
}

/** The origin the engine serves, read from the app's sealed declaration (`local_runtime.computer.public_origin`), or null. */
export function localDoorOrigin({ runtime = process.execPath, read = readText } = {}) {
  try { return new URL(JSON.parse(read(join(contentsOf(runtime), 'Resources', 'computer-reader.json'))).local_runtime.computer.public_origin).origin; }
  catch { return null; }
}

