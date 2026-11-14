/** Current-record workflow process for linking independently cleared answer evidence. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareQuestionGroundingLink } from '../prepare-question-grounding-link.mjs';
import { expectedCurrentFromContentHash } from '../../../live-namespace/read-data/expected-current-from-content-hash.mjs';

function rows(items) {
  if (!Array.isArray(items) || items.length >= 512) {
    throw new Error('Current record read is incomplete; grounding stopped without a write.');
  }
  return items;
}

function payload(item) {
  if (item?.payload) return item.payload;
  if (typeof item?.value_json === 'string') return JSON.parse(item.value_json);
  return item;
}

export function prepareNativeQuestionGrounding({ candidateId, partitionLabel, ventureRef,
  evidenceId, candidateItems, evidenceItems }) {
  if (!candidateId || !partitionLabel || !ventureRef || !evidenceId) {
    throw new Error('Exact candidate, venture and evidence coordinates are required.');
  }
  const candidates = rows(candidateItems).filter((item) => {
    const value = payload(item);
    return value?.kind === 'content-generation.question-candidate' && value.id === candidateId;
  });
  if (candidates.length === 0) return { accepted: false, reason: 'candidate_not_found' };
  if (candidates.length !== 1) throw new Error('Current candidate read is ambiguous.');
  const candidate = payload(candidates[0]);
  if (candidate.partition_label !== partitionLabel || candidate.venture_ref !== ventureRef) {
    return { accepted: false, reason: 'candidate_venture_mismatch' };
  }
  const evidence = rows(evidenceItems).map(payload).filter((value) =>
    value?.kind === 'content-generation.question-evidence' && value.id === evidenceId);
  if (evidence.length === 0) return { accepted: false, reason: 'answer_evidence_not_found' };
  if (evidence.length !== 1) throw new Error('Current answer evidence read is ambiguous.');
  return prepareQuestionGroundingLink({ candidate,
    candidateBasisHashBase64: expectedCurrentFromContentHash(candidates[0]?.content_hash).payload_hash_base64,
    evidence: evidence[0] });
}

export function verifyNativeQuestionGrounding(expected, readbackItems) {
  const matches = rows(readbackItems).map(payload).filter((row) => row?.id === expected?.id);
  if (matches.length !== 1 || matches[0].kind !== 'content-generation.question-candidate'
    || matches[0].revision !== expected.revision
    || matches[0].venture_ref !== expected.venture_ref
    || matches[0].partition_label !== expected.partition_label
    || JSON.stringify(matches[0].grounding_refs) !== JSON.stringify(expected.grounding_refs)) {
    throw new Error('Question grounding did not read back at the expected candidate revision.');
  }
  return { accepted: true, candidate: matches[0] };
}

async function main(argv) {
  if (argv[0] === '--native') {
    const [candidateId, partitionLabel, ventureRef, evidenceId, candidatePath, evidencePath] = argv.slice(1);
    if (!candidatePath || !evidencePath) throw new Error('Current candidate and evidence files are required.');
    return prepareNativeQuestionGrounding({ candidateId, partitionLabel, ventureRef, evidenceId,
      candidateItems: JSON.parse(await readFile(candidatePath, 'utf8')),
      evidenceItems: JSON.parse(await readFile(evidencePath, 'utf8')) });
  }
  if (argv[0] === '--verify') {
    const [expectedJson, readbackPath] = argv.slice(1);
    if (!expectedJson || !readbackPath) throw new Error('Expected candidate and readback are required.');
    return verifyNativeQuestionGrounding(JSON.parse(expectedJson),
      JSON.parse(await readFile(readbackPath, 'utf8')));
  }
  throw new Error('Grounding process needs --native or --verify.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${String(error?.message ?? error)}\n`); process.exitCode = 1; });
}
