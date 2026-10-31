// tools/legal-document-builder/do-work/make-a-sales-contract.mjs
//
// The command of tool:make-a-sales-contract. One JSON request on standard input:
//   { contract: { id?, name?, status?, currency?, total_amount?, intended_actor_id?, resource_id?, rules: [...] },
//     formats?: ["pdf", "csv", ...], actor_id?, base_url?, request_id?, created_at?, locale? }
// and one JSON line out: { result: { acceptance_requirements, terms_rows, file_request, output_forms, approval_link? } },
// or { error } and a non-zero exit. `formats` are file extensions from data/contract-output-targets.json (default: all);
// `file_request` is the structured-file-output request that tool:export-documents-to-files turns into the files;
// `approval_link` is made only when `base_url` is given. The work is read-data/contract-output.ts.
import { text as readStdin } from 'node:stream/consumers';
import {
  acceptanceRequirementsForContract, buildApprovalRequest, contractTermsRows, fileRequestFromApproval, readContractOutputTargets, safeFileStem,
} from '../read-data/contract-output.ts';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function makeSalesContract(input) {
  if (!isObject(input?.contract) || !Array.isArray(input.contract.rules)) throw new Error('contract must be an object with a rules list.');
  const known = readContractOutputTargets();
  const asked = input.formats === undefined ? known.map(target => target.file_extension) : input.formats;
  if (!Array.isArray(asked) || asked.length === 0) throw new Error('formats must list some of the output forms.');
  const unknown = asked.filter(extension => !known.some(target => target.file_extension === extension));
  if (unknown.length) throw new Error(`formats not known: ${unknown.join(', ')}. Known: ${known.map(target => target.file_extension).join(', ')}.`);
  const outputTargets = known.filter(target => asked.includes(target.file_extension));
  const locale = typeof input.locale === 'string' && input.locale ? input.locale : 'en-US';
  const createdAt = typeof input.created_at === 'string' && input.created_at ? new Date(input.created_at) : new Date();
  if (Number.isNaN(createdAt.getTime())) throw new Error('created_at must be a date and time.');
  const contractId = typeof input.contract.id === 'string' && input.contract.id ? input.contract.id : 'contract';
  const request = buildApprovalRequest({
    baseUrl: typeof input.base_url === 'string' ? input.base_url : '',
    contract: input.contract,
    actorId: typeof input.actor_id === 'string' ? input.actor_id : '',
    outputTargets,
    requestId: typeof input.request_id === 'string' && input.request_id ? input.request_id : `approval_${safeFileStem(contractId)}`,
    now: createdAt,
  });
  return {
    acceptance_requirements: acceptanceRequirementsForContract(input.contract),
    terms_rows: contractTermsRows(input.contract, locale),
    file_request: fileRequestFromApproval(request, locale),
    output_forms: outputTargets.map(target => ({ id: target.id, label: target.label, extension: target.file_extension, format_id: target.format_id })),
    ...(typeof input.base_url === 'string' && input.base_url ? { approval_link: request.approvalUrl } : {}),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: makeSalesContract(JSON.parse((await readStdin(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
