// PUT BUILT BYTES WHERE THE RUNNING APP ACTUALLY READS THEM.
//
// Package convergence decides what to do by comparing the SOURCE INPUTS it
// recorded last time. When those are unchanged it skips the build and reports
// no drift, which is correct reasoning about inputs and says nothing about the
// bytes currently stored. If the stored output is stale for any other reason,
// every convergence run from then on agrees there is nothing to do, and the
// app goes on serving the old program while the tree, the receipts and the
// drift report all read clean. Found on the hosted Trillion app: the sidebar
// record held a build with no surface narrowing in it, and three separate runs
// reported `applied` without changing a byte.
//
// So this compares the BYTES. It reads what is stored at an address, reads the
// built file, and writes only when they differ. It is the same
// `engine.operation.write-batch` every live data change goes through.
import { readFileSync } from 'node:fs';

import {
  scanCurrentUnderPath,
  sendRequestToRunningApp,
  startRunningAppSession,
} from '../../send-requests-to-an-engine/read-data/find-the-running-app-and-send-requests-to-it.mjs';

function requiredOption(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : null;
  if (typeof value !== 'string' || !value || value.startsWith('--')) {
    throw new Error(`${name} requires one value`);
  }
  return value;
}

function optionValues(args, name) {
  const found = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('--')) {
        throw new Error(`${name} requires one value`);
      }
      found.push(value);
    }
  }
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  const url = requiredOption(args, '--url');
  const partitionLabel = requiredOption(args, '--partition');
  const builtFile = requiredOption(args, '--built-file');
  // The EXACT record path, every label of it. Scanning a parent and writing
  // whatever is underneath would mean inventing path labels for records this
  // caller never named, and a scan answers with hashed segments, so the labels
  // cannot be recovered from it anyway.
  const pathLabels = optionValues(args, '--path');
  if (pathLabels.length === 0) throw new Error('name the record path with --path, once per label');

  const built = readFileSync(builtFile);
  const session = await startRunningAppSession({ url });

  const { entries } = await scanCurrentUnderPath(session, partitionLabel, pathLabels, { limit: 20 });
  if (entries.length !== 1) {
    throw new Error(`${pathLabels.join('/')} names ${entries.length} records, and this writes one`);
  }
  const [entry] = entries;
  const stored = entry.payload_base64 ? Buffer.from(entry.payload_base64, 'base64') : Buffer.alloc(0);
  process.stdout.write(`stored ${stored.length} bytes, built ${built.length} bytes\n`);
  if (stored.equals(built)) {
    process.stdout.write('the stored bytes are already the built bytes\n');
    return;
  }

  const answer = await sendRequestToRunningApp(session, 'engine.operation.label-addressed', {
    operation_label: 'engine.operation.write-batch',
    partition_label: partitionLabel,
    writes: [{
      address_label: entry.address,
      address_mode: 'multihash_hex',
      path_labels: pathLabels,
      payload_base64: built.toString('base64'),
    }],
  }, { timeoutMs: 900000 });

  process.stdout.write(`${entry.address}\n`);
  process.stdout.write(`${JSON.stringify(answer).slice(0, 300)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
});
