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
// round trip over the internet. Where the door is declared: the engine's own config (`listen`, written by the app on every
// launch), else the app bundle's declaration. The declaration's `public_origin` is the origin the engine serves (`localDoorOrigin`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const readText = file => readFileSync(file, 'utf8');

/** The app bundle's Contents folder holding `runtime` (its own node, Contents/MacOS/node). */
const contentsOf = runtime => dirname(dirname(runtime));

/** One declared door as http://127.0.0.1:<port>/mcp, or null when `host` and `port` are not this computer's loopback. */
const addressOf = (host, port) => (Number.isInteger(port) && port >= 1024 && port <= 65535 && host === '127.0.0.1' ? `http://${host}:${port}/mcp` : null);

const declarationOf = runtime => join(contentsOf(runtime), 'Resources', 'computer-reader.json');

/** The door's MCP address, http://127.0.0.1:<port>/mcp, from the first place that declares it:
 *  1. `configs`: the engine's own config files (`listen`, "127.0.0.1:<port>"), which the app writes on every launch from its
 *     sealed declaration, so they name the app wherever it is installed and the port it really serves;
 *  2. `runtimes`: each app node's bundle declaration (Contents/Resources/computer-reader.json `local_runtime.computer`).
 *  Nothing declared is an error that carries `tried`, every file looked at. */
export function localDoorAddress({ runtime = process.execPath, runtimes = [runtime], configs = [], read = readText } = {}) {
  const tried = [];
  const attempt = (file, pick) => {
    tried.push(file);
    try { return pick(JSON.parse(read(file))); } catch { return null; }
  };
  for (const file of configs) {
    const address = attempt(file, config => { const [host, port] = String(config.listen).split(':'); return addressOf(host, Number(port)); });
    if (address) return address;
  }
  for (const node of runtimes) {
    const address = attempt(declarationOf(node), reader => addressOf(reader.local_runtime?.computer?.listen_host, reader.local_runtime?.computer?.port));
    if (address) return address;
  }
  throw Object.assign(new Error('Run this with the node inside the installed Mac app, which names its local door.'), { tried });
}

/** The origin the engine serves, read from the app's sealed declaration (`local_runtime.computer.public_origin`), or null. */
export function localDoorOrigin({ runtime = process.execPath, read = readText } = {}) {
  try { return new URL(JSON.parse(read(declarationOf(runtime))).local_runtime.computer.public_origin).origin; }
  catch { return null; }
}
