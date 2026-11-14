// PUBLISH A PACKAGE SET'S RECORDS AT THE ADDRESS THEIR READERS USE.
//
// A package-set record file names an `address_prefix`, and each record's
// address is that prefix plus its own id. That address is what every consumer
// asks for: the application composition selection points at
// `package-set-record::application-composition-records::trillion` and resolves
// it by label.
//
// Package convergence writes these records under a PATH instead
// (`package-set-records/<set>/<record_set>/records`), which is a different
// address. Both exist, both hold a record, and only one of them is read. So a
// converged tree reports no drift while the running app keeps serving the
// revision it was installed with. That is how the web app went on offering
// every surface after the record that narrows it had been current in the source
// for a day: nothing was missing and nothing failed.
//
// This writes the records at the address their readers use. It is the same
// `engine.operation.write-batch` every live data change goes through.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

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
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new Error(`${name} requires one value`);
    }
    found.push(value);
  }
  return found;
}

/** Every record in one package-set record file, as writes at its own address. */
export function writesFromRecordFile(fileText, { partitionLabel, fileName }) {
  const document = JSON.parse(fileText);
  const prefix = document.address_prefix;
  if (typeof prefix !== 'string' || !prefix) {
    throw new Error(`${fileName} declares no address_prefix, so its records have no address`);
  }
  const records = Array.isArray(document.records) ? document.records : [];
  if (records.length === 0) throw new Error(`${fileName} holds no records`);
  const pathLabels = document.path_labels;
  if (pathLabels !== undefined && (!Array.isArray(pathLabels) || pathLabels.length === 0
    || pathLabels.some((label) => typeof label !== 'string' || !label))) {
    throw new Error(`${fileName} has invalid path_labels`);
  }
  return records.map((record) => {
    const id = record?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error(`a record in ${fileName} has no id, so it has no address`);
    }
    return {
      address_label: `${prefix}::${id}`,
      // The address a package-set record is read at. The prefix and id are
      // labels, and the store hashes them; asking for the text itself finds
      // nothing.
      address_mode: 'label_hash',
      partition_label: partitionLabel,
      ...(pathLabels === undefined ? {} : { path_labels: pathLabels }),
      payload_base64: Buffer.from(JSON.stringify(record), 'utf8').toString('base64'),
    };
  });
}

/**
 * The other shape a package-set record file takes: no `address_prefix`, so its
 * records have no address of their own and publish under the fallback path,
 * `package-set-records/<set>/<record_set>/records`, one address per record.
 *
 * Those addresses are minted by the publisher and cannot be worked out from
 * the file, so the live records are read and matched to the source by their
 * `id`. A source record whose id is not live yet is reported rather than
 * written, because inventing an address here would create a second copy at a
 * place nothing reads, which is the failure this whole file exists to undo.
 */
export async function writesByMatchingLiveRecords(session, fileText, { partitionLabel, packageSet, recordSet }, scan = scanCurrentUnderPath) {
  const document = JSON.parse(fileText);
  const records = Array.isArray(document.records) ? document.records : [];
  const pathLabels = ['package-set-records', packageSet, recordSet, 'records'];
  const { entries } = await scan(session, partitionLabel, pathLabels, { limit: 500 });
  const setPath = ['package-set-records', packageSet, recordSet];
  const { entries: setEntries } = await scan(session, partitionLabel, setPath, { limit: 500 });
  const setMatches = setEntries.filter((entry) => entry?.payload?.kind === document.kind);
  if (setMatches.length !== 1) {
    throw new Error(`${setMatches.length} live record-set documents of kind ${document.kind} under ${setPath.join('/')}`);
  }

  const addressById = new Map();
  for (const entry of entries) {
    const id = entry?.payload?.id;
    if (typeof id === 'string' && id) addressById.set(id, entry.address);
  }

  const writes = [{
    address_label: setMatches[0].address,
    address_mode: 'multihash_hex',
    path_labels: setPath,
    payload: document,
  }];
  const absent = [];
  for (const record of records) {
    const address = addressById.get(record?.id);
    const recordPath = Array.isArray(record?.path) && record.path.length > 0
      ? record.path
      : pathLabels;
    const recordPayload = Object.hasOwn(record ?? {}, 'payload') ? record.payload : record;
    if (typeof record?.address_label_text === 'string' && record.address_label_text.trim()) {
      writes.push({
        address_label: record.address_label_text,
        address_mode: 'identity_text',
        path_labels: recordPath,
        payload: recordPayload,
      });
      continue;
    }
    if (!address) {
      // A source row that carries its own canonical address is safe to admit
      // before the first projection. The label-addressed engine derives the
      // opaque multihash from this stable label; we are not guessing a minted
      // address. Rows without that explicit owner address remain fail-closed.
      if (typeof record?.address === 'string' && record.address.trim()) {
        writes.push({
          address_label: record.address,
          address_mode: record.address_mode ?? 'identity_text',
          path_labels: recordPath,
          payload: recordPayload,
        });
        continue;
      }
      absent.push(record?.id ?? '<no id>');
      continue;
    }
    writes.push({
      address_label: address,
      address_mode: 'multihash_hex',
      path_labels: recordPath,
      payload: recordPayload,
    });
  }
  if (absent.length > 0) {
    process.stdout.write(`not live, so not written: ${absent.join(', ')}\n`);
  }
  return writes;
}

/**
 * The third shape: a file that IS one record, with no `records` array wrapping
 * it. The hosted page description is written this way, one document describing
 * every page a deployment serves.
 *
 * It publishes under the record set named by the file, and it is matched live
 * by its `kind`, because one document of a kind is current at a time and the
 * address was minted by the publisher. More than one live match is refused
 * rather than guessed at: picking one would overwrite a record nobody named.
 */
async function writeByMatchingLiveKind(session, fileText, { partitionLabel, recordSet, packageSet }) {
  const record = JSON.parse(fileText);
  const kind = record?.kind;
  if (typeof kind !== 'string' || !kind) {
    throw new Error(`${recordSet} is neither a record set nor a record with a kind`);
  }
  // At the record set itself, with no `records` beneath it. A file holding a
  // LIST publishes each record under `records`; a file that is one record has
  // no list to be inside, and measuring the live path confirmed three segments
  // rather than four. Guessing the fourth finds nothing and reads as an absent
  // record rather than a wrong address.
  const pathLabels = ['package-set-records', packageSet, recordSet];
  const { entries } = await scanCurrentUnderPath(session, partitionLabel, pathLabels, { limit: 500 });
  const matches = entries.filter((entry) => entry?.payload?.kind === kind);
  if (matches.length !== 1) {
    throw new Error(`${matches.length} live records of kind ${kind} under ${pathLabels.join('/')}, and this writes one`);
  }
  return [{
    address_label: matches[0].address,
    address_mode: 'multihash_hex',
    path_labels: pathLabels,
    payload: record,
  }];
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.includes('--url') ? requiredOption(args, '--url') : undefined;
  const appId = args.includes('--app-id') ? requiredOption(args, '--app-id') : undefined;
  if (Boolean(url) === Boolean(appId)) throw new Error('name exactly one --url or --app-id');
  const partitionLabel = requiredOption(args, '--partition');
  const files = optionValues(args, '--record-file');
  if (files.length === 0) throw new Error('name at least one --record-file');

  const session = await startRunningAppSession({ url, appId });

  const writes = [];
  for (const file of files) {
    const fileText = readFileSync(file, 'utf8');
    const document = JSON.parse(fileText);
    if (typeof document.address_prefix === 'string' && document.address_prefix) {
      writes.push(...writesFromRecordFile(fileText, { partitionLabel, fileName: basename(file) }));
      continue;
    }
    const recordSet = document.record_set ?? basename(file).replace(/\.json$/, '');
    const packageSet = document.package_set ?? partitionLabel;
    if (!Array.isArray(document.records)) {
      writes.push(...await writeByMatchingLiveKind(session, fileText, {
        partitionLabel, recordSet, packageSet,
      }));
      continue;
    }
    writes.push(...await writesByMatchingLiveRecords(session, fileText, {
      partitionLabel, packageSet, recordSet,
    }));
  }
  if (writes.length === 0) throw new Error('nothing to write');
  const answer = await sendRequestToRunningApp(session, 'engine.operation.label-addressed', {
    operation_label: 'engine.operation.write-batch',
    partition_label: partitionLabel,
    writes,
  }, { timeoutMs: 600000 });

  for (const write of writes) process.stdout.write(`${write.address_label}\n`);
  process.stdout.write(`${writes.length} records written\n`);
  process.stdout.write(`${JSON.stringify(answer).slice(0, 400)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  });
}
