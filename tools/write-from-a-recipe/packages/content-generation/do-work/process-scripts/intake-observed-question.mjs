/** Selected-app workflow process for an observed audience question. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareObservedQuestion } from '../prepare-observed-question.mjs';

function rows(items) {
  if (!Array.isArray(items) || items.length >= 512) throw new Error('Current record read is incomplete.');
  return items.map((item) => item?.payload ?? item).filter(Boolean);
}
function one(items, label) {
  if (items.length !== 1) throw new Error(`Expected one current ${label}; found ${items.length}.`);
  return items[0];
}

export function prepareNativeObservedQuestion({ sourceAtomRef, routeId, question,
  observationItems, routeItems, candidateItems }) {
  const observations = rows(observationItems).filter((row) => row.kind === 'observed-content.content-atom'
    && row.atom_ref === sourceAtomRef);
  const routes = rows(routeItems).filter((row) => row.kind === 'content-generation.question-source-route'
    && row.id === routeId);
  if (observations.length === 0) return { accepted: false, reason: 'source_observation_not_found' };
  if (routes.length === 0) return { accepted: false, reason: 'question_source_route_not_found' };
  const observation = one(observations, 'observation');
  const route = one(routes, 'source route');
  const decision = prepareObservedQuestion({ observation, route, question });
  if (!decision.accepted) return decision;
  if (rows(candidateItems).some((row) => row.kind === 'content-generation.question-candidate'
    && row.id === decision.candidate.id)) return { accepted: false, reason: 'candidate_already_exists' };
  return decision;
}

export function verifyNativeObservedQuestion(expected, evidenceItems, candidateItems) {
  const evidence = one(rows(evidenceItems).filter((row) => row.id === expected?.evidence?.id), 'evidence readback');
  const candidate = one(rows(candidateItems).filter((row) => row.id === expected?.candidate?.id), 'candidate readback');
  if (evidence.revision !== expected.evidence.revision || candidate.revision !== expected.candidate.revision
    || candidate.evidence_refs?.[0]?.id !== evidence.id || evidence.venture_ref !== candidate.venture_ref) {
    throw new Error('Observed question did not read back at the expected revision.');
  }
  return { accepted: true, evidence, candidate };
}

async function main(argv) {
  if (argv[0] === '--native') {
    const [sourceAtomRef, routeId, question, observationPath, routePath, candidatePath] = argv.slice(1);
    if (!candidatePath) throw new Error('Current observation, route and candidate files are required.');
    const [observationItems, routeItems, candidateItems] = await Promise.all(
      [observationPath, routePath, candidatePath].map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
    return prepareNativeObservedQuestion({ sourceAtomRef, routeId, question,
      observationItems, routeItems, candidateItems });
  }
  if (argv[0] === '--verify') {
    const [expected, evidencePath, candidatePath] = argv.slice(1);
    if (!candidatePath) throw new Error('Expected intake and two current readbacks are required.');
    return verifyNativeObservedQuestion(JSON.parse(expected),
      JSON.parse(await readFile(evidencePath, 'utf8')),
      JSON.parse(await readFile(candidatePath, 'utf8')));
  }
  throw new Error('Intake process needs --native or --verify.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`${String(error?.message ?? error)}\n`); process.exitCode = 1; });
}
