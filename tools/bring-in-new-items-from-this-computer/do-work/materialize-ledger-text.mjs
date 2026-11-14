/** Project one validated, authorized ledger text item into a current content atom. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const atomIdentity = /^atom:1f:[0-9a-f]{64}$/;

export function prepareLedgerTextAtom({ ledger, sourceRef, nativeRef, partitionLabel }) {
  if (!text(sourceRef) || !text(nativeRef) || !text(partitionLabel)) {
    return { accepted: false, reason: 'missing_source_identity_or_partition' };
  }
  const matches = Array.isArray(ledger?.accepted) ? ledger.accepted.filter((item) =>
    item?.source_ref === sourceRef && item?.native_ref === nativeRef) : [];
  if (matches.length !== 1) return { accepted: false, reason: 'source_observation_not_unique' };
  const observation = matches[0];
  const authorization = observation.source_authorization;
  const provenance = observation.source_provenance;
  if (authorization?.status !== 'authorized' || !text(authorization.authorization_scope_ref)
    || authorization.partition_label !== partitionLabel) {
    return { accepted: false, reason: 'source_not_authorized_for_partition' };
  }
  if (provenance?.source_ref !== sourceRef || provenance?.native_ref !== nativeRef
    || !text(observation.source_identity_ref) || !text(observation.source_revision_ref)
    || observation.source_revision_ref !== observation.content_multihash) {
    return { accepted: false, reason: 'source_provenance_mismatch' };
  }
  const sourceText = text(observation.payload?.text);
  if (!sourceText || sourceText.length > 20000 || !Number.isFinite(Date.parse(observation.observed_at))) {
    return { accepted: false, reason: 'text_or_observation_time_invalid' };
  }
  const atomRef = observation.payload?.atom_ref;
  if (!atomIdentity.test(atomRef)) return { accepted: false, reason: 'missing_canonical_atom_identity' };
  const atom = {
    kind: 'observed-content.content-atom', atom_ref: atomRef, source_ref: sourceRef,
    native_ref: nativeRef, source_identity_ref: observation.source_identity_ref,
    source_revision_ref: observation.source_revision_ref,
    source_authorization: authorization, source_provenance: provenance,
    correlation_ref: observation.correlation_ref, at: observation.observed_at,
    content: { text: sourceText }, atom_kind: 'text-observation',
  };
  return { accepted: true, atom, writes: [{
    partition_label: partitionLabel, address_label: atomRef, address_mode: 'identity_text',
    path_labels: ['current-item', 'published-record'], payload: atom,
    expected_current: { payload_hash_base64: null },
  }] };
}

export function verifyLedgerTextAtom(expected, readback) {
  const atom = readback?.found === true ? readback.payload : null;
  if (atom?.kind !== 'observed-content.content-atom'
    || !isDeepStrictEqual(atom, expected?.atom)) {
    throw new Error('Current text atom does not match the admitted source revision.');
  }
  return { accepted: true, atom };
}

async function main(argv) {
  if (argv[0] === '--prepare') {
    const [sourceRef, nativeRef, partitionLabel, ledgerPath] = argv.slice(1);
    if (!ledgerPath) throw new Error('Ledger readback is required.');
    const reply = JSON.parse(await readFile(ledgerPath, 'utf8'));
    return prepareLedgerTextAtom({ ledger: reply?.payload ?? reply, sourceRef, nativeRef, partitionLabel });
  }
  if (argv[0] === '--verify') {
    const [expectedText, readbackPath] = argv.slice(1);
    if (!readbackPath) throw new Error('Current atom readback is required.');
    return verifyLedgerTextAtom(JSON.parse(expectedText), JSON.parse(await readFile(readbackPath, 'utf8')));
  }
  throw new Error('Materialization needs --prepare or --verify.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${String(error?.message ?? error)}\n`); process.exitCode = 1; });
}
