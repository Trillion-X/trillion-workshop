// scripts/installed-modules.mjs
//
// Purpose
//   The folder this build reads installed packages from: the node_modules that holds trillion-workshop, found by walking up
//   from the client's folder. In a Workshop checkout that is the checkout's own node_modules (package.json links the
//   Workshop to itself there); in a consumer that installed the Workshop it is the consumer's node_modules. The build never
//   names where it sits, so the same files build the client from either.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function installedModules(from) {
  for (let folder = from; ; folder = dirname(folder)) {
    if (existsSync(join(folder, 'node_modules/trillion-workshop'))) return join(folder, 'node_modules');
    if (dirname(folder) === folder) throw new Error(`No node_modules holding trillion-workshop above ${from}; run npm ci.`);
  }
}
