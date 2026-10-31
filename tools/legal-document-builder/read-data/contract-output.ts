// tools/legal-document-builder/read-data/contract-output.ts
//
// Pure contract output: what a person must accept, the terms of an accepted contract as rows, the file request that
// turns those rows into a PDF, Word, spreadsheet, Markdown or text file, and the approval link that carries a contract
// to the person who accepts it. Carried from bitfield-packages packages/sales-contract-builder
// (read-data/sales-contract-output-targets.ts). Left behind there: the screen's service-connection picking, and the
// workflow and payment-session payloads, which only the old engine consumed.
//
// Invariants:
// - A contract is any JSON with `rules`; a rule of type Commitment asks for the payment acknowledgement, and one with a
//   payment_schedule asks for the installment authorization. No product, price or party is known here.
// - The output forms are DATA (data/contract-output-targets.json): a form that is not listed has no file request.
// - The approval link holds the whole request, so a link opened on another computer shows the same contract.

import targetData from '../data/contract-output-targets.json' with { type: 'json' };

export type ContractOutputTarget = {
  id: string;
  label: string;
  short_label: string;
  description: string;
  action_label: string;
  output_kind: string;
  file_extension: string;
  format_id: string;
};

export type ContractApprovalRequest = {
  kind: 'sales-contract-builder.approval-request.v1';
  requestId: string;
  approvalUrl: string;
  createdAt: string;
  contract: Record<string, unknown>;
  actorId: string;
  outputTargets: ContractOutputTarget[];
  acceptanceRequirements: string[];
};

export type FileRequest = {
  kind: 'structured-file-output.request';
  requestId: string;
  title: string;
  fileStem: string;
  createdAt: string;
  formats: string[];
  sections: { heading: string; rows: string[][] }[];
  source: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback);
const number = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export function readContractOutputTargets(data: { targets?: unknown } = targetData): ContractOutputTarget[] {
  const rows = Array.isArray(data.targets) ? data.targets : [];
  return rows.flatMap((row): ContractOutputTarget[] => {
    if (!isRecord(row)) return [];
    const id = text(row.id);
    const label = text(row.label);
    const fileExtension = text(row.file_extension);
    const formatId = text(row.format_id);
    if (!id || !label || !fileExtension || !formatId) return [];
    return [{
      id, label, short_label: text(row.short_label, label), description: text(row.description),
      action_label: text(row.action_label, `Make ${label}`), output_kind: text(row.output_kind, 'document-file'),
      file_extension: fileExtension, format_id: formatId,
    }];
  }).sort((left, right) => left.label.localeCompare(right.label));
}

export function safeFileStem(value: string, fallback = 'contract'): string {
  return (value || fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

export function acceptanceRequirementsForContract(contract: Record<string, unknown>): string[] {
  const rules = Array.isArray(contract.rules) ? contract.rules : [];
  const hasCommitment = rules.some((rule) => isRecord(rule) && rule.type === 'Commitment');
  const hasInstallment = rules.some((rule) =>
    isRecord(rule) && rule.type === 'Commitment' && isRecord(rule.metadata)
    && Array.isArray(rule.metadata.payment_schedule) && rule.metadata.payment_schedule.length > 0);
  return [
    'I understand the contract terms.',
    ...(hasCommitment ? ['I understand the payment obligation.'] : []),
    ...(hasInstallment ? ['I authorize the installment payment schedule.'] : []),
  ];
}

function formatMoney(cents: unknown, currency: string, locale: string): string {
  return `${currency} ${(number(cents) / 100).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function contractTermsRows(contract: Record<string, unknown>, locale = 'en-US'): string[][] {
  const currency = text(contract.currency, 'usd').toUpperCase();
  const rows = [
    ['Field', 'Value'],
    ['Contract', text(contract.name, 'Sales contract')],
    ['Status', text(contract.status, 'draft')],
    ['Customer', text(contract.intended_actor_id, 'Prospect')],
    ['Primary offer', text(contract.resource_id, 'Primary offer')],
    ['Total', formatMoney(contract.total_amount, currency, locale)],
    ['Currency', currency],
  ];
  const rules = Array.isArray(contract.rules) ? contract.rules.filter((rule): rule is Record<string, unknown> => isRecord(rule)) : [];
  rules.forEach((rule, index) => {
    const metadata = isRecord(rule.metadata) ? rule.metadata : {};
    rows.push([
      `Rule ${index + 1}`,
      [
        text(rule.type, 'Rule'),
        text(rule.label),
        number(rule.amount) ? formatMoney(rule.amount, currency, locale) : '',
        text(rule.recurrence),
        Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : '',
      ].filter(Boolean).join(' | '),
    ]);
  });
  return rows;
}

export function fileRequestFromApproval(request: ContractApprovalRequest, locale = 'en-US'): FileRequest {
  const title = text(request.contract.name, 'Sales contract');
  const formats = [...new Set(request.outputTargets.map((target) => target.format_id))];
  return {
    kind: 'structured-file-output.request',
    requestId: `${request.requestId}:files`,
    title,
    fileStem: safeFileStem(title, 'sales-contract'),
    createdAt: request.createdAt,
    formats,
    sections: [{ heading: 'Contract terms', rows: contractTermsRows(request.contract, locale) }],
    source: { approval_request_id: request.requestId, contract_id: text(request.contract.id, request.requestId) },
  };
}

export function encodeApprovalRequestMaterial(request: Omit<ContractApprovalRequest, 'approvalUrl'>): string {
  return Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
}

export function decodeApprovalRequestMaterial(value: string): ContractApprovalRequest | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(decoded) || decoded.kind !== 'sales-contract-builder.approval-request.v1') return null;
    return decoded as ContractApprovalRequest;
  } catch {
    return null;
  }
}

export function buildApprovalLink(baseUrl: string, request: Omit<ContractApprovalRequest, 'approvalUrl'>): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return `${base}/contracts/approve/${request.requestId}?request=${encodeApprovalRequestMaterial(request)}`;
}

export function readApprovalRequestFromLocation(location: { pathname: string; search: string }): ContractApprovalRequest | null {
  if (!location.pathname.startsWith('/contracts/approve/')) return null;
  const request = decodeApprovalRequestMaterial(new URLSearchParams(location.search).get('request') ?? '');
  if (!request) return null;
  const requestId = location.pathname.split('/').filter(Boolean).at(-1);
  return requestId === request.requestId ? { ...request, approvalUrl: `${location.pathname}${location.search}` } : null;
}

export function buildApprovalRequest(args: {
  baseUrl: string;
  contract: Record<string, unknown>;
  actorId: string;
  outputTargets: readonly ContractOutputTarget[];
  requestId: string;
  now: Date;
}): ContractApprovalRequest {
  const withoutUrl: Omit<ContractApprovalRequest, 'approvalUrl'> = {
    kind: 'sales-contract-builder.approval-request.v1',
    requestId: args.requestId,
    createdAt: args.now.toISOString(),
    contract: args.contract,
    actorId: args.actorId,
    outputTargets: [...args.outputTargets],
    acceptanceRequirements: acceptanceRequirementsForContract(args.contract),
  };
  return { ...withoutUrl, approvalUrl: buildApprovalLink(args.baseUrl, withoutUrl) };
}
