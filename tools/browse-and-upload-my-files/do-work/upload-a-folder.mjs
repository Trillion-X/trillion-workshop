#!/usr/bin/env node
// Upload every file in a folder into your own private file space on the service this program came from.
//
//   node upload-files.mjs <folder>
//
// Your browser opens so you can sign in; then each file is uploaded and listed as it lands. Run it again any time:
// files already uploaded are not sent again. A program that already holds an account key (the personal key from the
// account page) can pass it in the ACCOUNT_KEY environment variable instead of signing in.
//
// Options, all optional: --to <service address> (the service this program was downloaded from, when served; required
// when run from source), --parallel <n> (16 chunks in flight at once), --as <folder> (the folder the files are named
// under in your files, such as "Amie recordings"; the folder's own name when left out). Hidden files (.DS_Store and
// other names starting with ".") are not sent.
import { bearerControl, namespaceClient } from './namespace-client.mjs';
import { sendFolder, signInWithBrowser } from './send-a-folder-to-a-namespace.mjs';
import { fetchWithoutCopies } from './send-without-copies.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const at = argv.indexOf(name); return at < 0 ? fallback : argv[at + 1]; };
const folder = argv.find((value, index) => !value.startsWith('--') && !argv[index - 1]?.startsWith('--'));
// A served copy has the address it was served from written in when it was built.
const origin = option('--to', typeof SERVICE_ORIGIN === 'string' ? SERVICE_ORIGIN : null);
const say = line => process.stdout.write(`${line}\n`);

if (!folder || !origin) {
  process.stderr.write(`Give the folder to upload${origin ? '' : ' and --to <service address>'}: node upload-files.mjs <folder>\n`);
  process.exit(2);
}
try {
  const accountKey = process.env.ACCOUNT_KEY;
  const authorization = accountKey ? async () => `Bearer ${accountKey}` : await signInWithBrowser({ origin, say });
  // Chunks go to the socket as they are (Node's fetch copies each body), so memory stays near the chunks in flight.
  const client = namespaceClient({ origin, control: bearerControl({ origin, authorization }), fetchImpl: fetchWithoutCopies });
  const result = await sendFolder({ folder, client, say, parallel: Math.max(1, Number(option('--parallel', 16))), as: option('--as', null) });
  process.exit(result.stopped ? 3 : 0);
} catch (error) {
  process.stderr.write(`Stopped: ${error.message}\n`);
  process.exit(1);
}
