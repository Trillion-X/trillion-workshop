// New: the package this carries (bitfield-packages packages/sales-contract-builder) had no test. Every contract here is made up.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  acceptanceRequirementsForContract,
  buildApprovalLink,
  buildApprovalRequest,
  contractTermsRows,
  decodeApprovalRequestMaterial,
  encodeApprovalRequestMaterial,
  fileRequestFromApproval,
  readApprovalRequestFromLocation,
  readContractOutputTargets,
  safeFileStem,
} from '../read-data/contract-output.ts';

const contract = {
  id: 'contract-1',
  name: 'Studio Membership Agreement',
  status: 'active',
  currency: 'usd',
  total_amount: 129900,
  intended_actor_id: 'person-7',
  resource_id: 'studio-membership',
  rules: [
    { type: 'Commitment', label: 'Membership', amount: 129900, recurrence: 'monthly', metadata: { payment_schedule: [{ due: '2030-01-01', amount: 129900 }] } },
    { type: 'GrantAccess', resource: 'studio-membership', condition: 'commitment_active' },
  ],
};
const targets = readContractOutputTargets();

describe('output forms are DATA', () => {
  it('lists the forms in data/contract-output-targets.json by label, each with its extension and file-maker format', () => {
    expect(targets.map((target) => target.file_extension)).toEqual(['csv', 'xlsx', 'md', 'pdf', 'txt']);
    expect(targets.find((target) => target.file_extension === 'md')?.format_id).toBe('markdown');
    expect(targets.find((target) => target.id === 'output-target:pdf')?.action_label).toBe('Make PDF');
  });
  it('keeps a row with every field and drops one without, and fills the label-derived fields', () => {
    const read = readContractOutputTargets({ targets: [
      { id: 'output-target:odt', label: 'Open Document', file_extension: 'odt', format_id: 'odt' },
      { id: 'output-target:broken', label: 'No extension', format_id: 'x' },
      'not a row',
    ] });
    expect(read.length).toBe(1);
    expect(read[0].short_label).toBe('Open Document');
    expect(read[0].action_label).toBe('Make Open Document');
    expect(read[0].output_kind).toBe('document-file');
    expect(readContractOutputTargets({}).length).toBe(0);
  });
});

describe('acceptanceRequirementsForContract', () => {
  it('always asks for the terms, adds the payment obligation for a commitment and the schedule for an installment one', () => {
    expect(acceptanceRequirementsForContract({ rules: [] })).toEqual(['I understand the contract terms.']);
    expect(acceptanceRequirementsForContract({ rules: [{ type: 'Commitment' }] })).toEqual([
      'I understand the contract terms.', 'I understand the payment obligation.',
    ]);
    expect(acceptanceRequirementsForContract(contract)).toEqual([
      'I understand the contract terms.', 'I understand the payment obligation.', 'I authorize the installment payment schedule.',
    ]);
    expect(acceptanceRequirementsForContract({})).toEqual(['I understand the contract terms.']);
  });
});

describe('contractTermsRows', () => {
  it('writes the header, the contract facts and one row per rule, money in the given locale', () => {
    const rows = contractTermsRows(contract);
    expect(rows[0]).toEqual(['Field', 'Value']);
    expect(rows[1]).toEqual(['Contract', 'Studio Membership Agreement']);
    expect(rows).toContain(['Total', 'USD 1,299.00']);
    expect(rows).toContain(['Customer', 'person-7']);
    expect(rows).toContain(['Rule 1', 'Commitment | Membership | USD 1,299.00 | monthly | {"payment_schedule":[{"due":"2030-01-01","amount":129900}]}']);
    expect(rows).toContain(['Rule 2', 'GrantAccess']);
    expect(contractTermsRows(contract, 'de-DE')).toContain(['Total', 'USD 1.299,00']);
  });
  it('fills what a bare contract lacks with plain words', () => {
    expect(contractTermsRows({ rules: [] })).toEqual([
      ['Field', 'Value'], ['Contract', 'Sales contract'], ['Status', 'draft'], ['Customer', 'Prospect'],
      ['Primary offer', 'Primary offer'], ['Total', 'USD 0.00'], ['Currency', 'USD'],
    ]);
  });
});

describe('the file request and the approval link', () => {
  const now = new Date('2030-03-04T05:06:07.000Z');
  const request = buildApprovalRequest({
    baseUrl: 'https://deals.example/', contract, actorId: 'person-7',
    outputTargets: targets.filter((target) => ['pdf', 'md'].includes(target.file_extension)), requestId: 'approval_one', now,
  });

  it('builds the request a file maker takes: the terms as one section and the forms as format ids', () => {
    const file = fileRequestFromApproval(request);
    expect(file.kind).toBe('structured-file-output.request');
    expect(file.requestId).toBe('approval_one:files');
    expect(file.title).toBe('Studio Membership Agreement');
    expect(file.fileStem).toBe('studio-membership-agreement');
    expect(file.createdAt).toBe('2030-03-04T05:06:07.000Z');
    expect(file.formats).toEqual(['markdown', 'pdf']);
    expect(file.sections.length).toBe(1);
    expect(file.sections[0].heading).toBe('Contract terms');
    expect(file.sections[0].rows).toEqual(contractTermsRows(contract));
    expect(file.source).toEqual({ approval_request_id: 'approval_one', contract_id: 'contract-1' });
  });

  it('carries the whole request in the link, so another computer reads the same contract back', () => {
    expect(request.approvalUrl.startsWith('https://deals.example/contracts/approve/approval_one?request=')).toBe(true);
    const url = new URL(request.approvalUrl);
    const read = readApprovalRequestFromLocation({ pathname: url.pathname, search: url.search });
    expect(read?.contract).toEqual(contract);
    expect(read?.actorId).toBe('person-7');
    expect(read?.acceptanceRequirements.length).toBe(3);
    expect(read?.approvalUrl).toBe(`${url.pathname}${url.search}`);
  });

  it('refuses a link whose id differs from its request, one off the approve path, and material that is not a request', () => {
    const url = new URL(request.approvalUrl);
    expect(readApprovalRequestFromLocation({ pathname: '/contracts/approve/approval_two', search: url.search })).toBeNull();
    expect(readApprovalRequestFromLocation({ pathname: '/somewhere/else', search: url.search })).toBeNull();
    expect(readApprovalRequestFromLocation({ pathname: url.pathname, search: '?request=not-a-request' })).toBeNull();
    expect(decodeApprovalRequestMaterial(Buffer.from(JSON.stringify({ kind: 'other' })).toString('base64url'))).toBeNull();
    expect(decodeApprovalRequestMaterial('')).toBeNull();
  });

  it('keeps non-ASCII words through the link and trims slashes from the base address', () => {
    const { approvalUrl: ignored, ...bare } = request;
    expect(ignored.length > 0).toBe(true);
    const odd = { ...bare, contract: { ...contract, name: 'Accord de location, août' } };
    expect(decodeApprovalRequestMaterial(encodeApprovalRequestMaterial(odd))?.contract.name).toBe('Accord de location, août');
    expect(buildApprovalLink('https://deals.example///', bare).startsWith('https://deals.example/contracts/approve/approval_one?')).toBe(true);
  });
});

describe('safeFileStem', () => {
  it('makes a lower-case word-and-dash stem and falls back when nothing is left', () => {
    expect(safeFileStem('  Terms & Conditions (v2)! ')).toBe('terms-conditions-v2');
    expect(safeFileStem('***', 'fallback')).toBe('fallback');
    expect(safeFileStem('')).toBe('contract');
  });
});
