import { createHash } from 'node:crypto';

import {
  createTrustedRuntimeIdMinter,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import processSessionContract from '../things-to-store-and-run.json';
import {
  readConfiguredTimedTarget,
  renderProcessSessionLaunchDescriptor,
  type EnvBinding,
  type PathBinding,
  type ProcessInputMount,
  type ProcessSessionLaunchDescriptor,
} from '../read-data/read-process-session-launch.ts';
import { buildProcessSessionStartRequest } from '../envelope-client/start-process-session.ts';

const PROCESS_SESSION_ROUTE = readConfiguredTimedTarget(processSessionContract, 'process-session');
const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_READ_CURRENT_OPERATION = 'engine.operation.read-current';
const PUBLISHED_RECORDS_ADDRESS_LABEL = 'published-records';
const TOOL_RECORD_PREFIX = 'package::ai-tool-catalog::tool::';
const GUARD_POLICY_TARGET = 'ai-action-guard.evaluate-guard-policy';
const WORKFLOW_TARGET = 'slot::workflow';
const PERMISSION_DEFINITION = 'action:permission-lease.evaluate-capability';
const AUTHORIZATION_TIME_TARGET = 'permission-lease.read-authorization-time';
const BUDGET_DEFINITION = 'action:budget-gate';
const TEXT_DECODER = new TextDecoder();
const NULL_CELL_LENGTH = 0xffff_ffff;

export interface AssignedWorkSourceRecord {
  id: string;
  owner?: string;
  kind?: string;
  title?: string;
  objective?: string;
  acceptanceCriteria?: unknown;
  assignedTo?: readonly string[];
  attachments?: unknown;
  proofLinks?: unknown;
  contextDescriptorRefs?: readonly string[];
  proofSinkRefs?: readonly string[];
  estimatedCost?: number;
  walletRef?: string;
  effectBoundary?: string;
  state?: string;
  executionPreconditions?: readonly {
    record_ref: string;
    address_mode?: 'identity_text' | 'label_hash';
    path: string[];
    expected: unknown;
  }[];
}

export interface AssignedWorkProfile {
  id: string;
  label?: string;
  modelRefs?: readonly string[];
  toolRefs?: readonly string[];
  instructionRefs?: readonly string[];
  memoryRefs?: readonly string[];
  instructionSelection?: Readonly<Record<string, unknown>>;
  executionContract?: string;
  processLaunch?: AssignedWorkLaunchTemplate;
  process_launch?: AssignedWorkLaunchTemplate;
  launch?: AssignedWorkLaunchTemplate;
}

export interface AssignedWorkTeamRecord {
  id: string;
  label?: string;
  memberRefs: readonly string[];
  launchPolicy?: 'all-members' | 'first-available';
}

/**
 * Self-describing declaration of WHERE this launch runs its model.
 *
 * The owner is not allowed to restate the model id here: `argvIndex` points at
 * the real argv slot, so the launched model is always read from the argv that
 * actually runs. A launcher that puts its model somewhere else, or runs a
 * different binary, declares that here as DATA. Nothing about any particular
 * CLI, vendor, or model family is known to this file.
 */
export interface AssignedWorkLaunchModelBinding {
  argvIndex: number;
  executable?: string;
}

export interface AssignedWorkLaunchTemplate {
  argv: readonly string[];
  cwd?: PathBinding;
  env?: readonly EnvBinding[];
  inputs?: readonly ProcessInputMount[];
  timeoutMs?: number;
  operationClaimToken?: string;
  budgetReservationToken?: string;
  modelBinding?: AssignedWorkLaunchModelBinding;
}

export interface AssignedWorkLaunchInput {
  source: AssignedWorkSourceRecord;
  worker: AssignedWorkProfile;
  launchTemplate?: AssignedWorkLaunchTemplate;
  fallbackLaunchTemplate?: AssignedWorkLaunchTemplate;
  team?: AssignedWorkTeamRecord;
  claimToken?: string;
  budgetReservationToken?: string;
  correlationRef?: string;
}

export interface AssignedWorkSessionStartResult {
  eventFeedAddress: string | null;
  sessionId: string;
  sourceRef: string;
  teamRef: string | null;
  workerRef: string;
  runtimeProvenance: {
    workerRef: string;
    workerModelRefs: readonly string[];
    renderedArgv: readonly string[];
    instructionSelection: Readonly<Record<string, unknown>> | null;
    sourceObjectiveSha256: string;
    mountedInputIdentities: readonly {
      mountPath: string;
      contentType: string | null;
      executable: boolean;
      sourceKind: string;
      sourceHash: string | null;
    }[];
    finalInputIdentityDigest: string;
  };
}

export interface AssignedRecordWorkActionPayload {
  action_id?: string;
  input?: Record<string, unknown>;
  operation?: string;
}

export interface AuthorizedAssignedWorkInput {
  sourceRecordRef: string;
  workerRecordRef: string;
  workerRecordAddressMode?: 'identity_text' | 'label_hash';
  toolRecordRef: string;
  toolRecordAddressMode?: 'identity_text' | 'label_hash';
}

export interface AuthorizedAssignedWorkResult extends AssignedWorkSessionStartResult {
  authorizationProvenance: {
    toolRecordRef: string;
    guardBasisRef: string;
    permissionBasisRefs: readonly string[];
    budgetCheckRef: string;
    budgetReservationRef: string;
    processIdempotencyKey: string;
  };
}

interface ProcessSessionReplyEnvelope {
  payload?: Uint8Array;
}

export type TargetRequestSender = (request: { target: string; payload: unknown }) => Promise<unknown>;

export interface PublishedRecordRow {
  address?: string;
  payload?: unknown;
}

interface ProcessSessionReply {
  result?: unknown;
  reason?: unknown;
  session_id?: unknown;
  snapshot?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function firstTextList(...values: readonly unknown[]): string[] {
  for (const value of values) {
    const list = textList(value);
    if (list.length > 0) return list;
  }
  return [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function contractThings(): Record<string, unknown>[] {
  return Array.isArray(processSessionContract.things)
    ? processSessionContract.things.filter((thing): thing is Record<string, unknown> => isRecord(thing) && thing.remove !== true)
    : [];
}

function readLaunchTemplate(value: unknown): AssignedWorkLaunchTemplate | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const argv = textList(record.argv);
  if (argv.length === 0) return undefined;
  const cwd = asRecord(record.cwd) as PathBinding | null;
  const env = Array.isArray(record.env) ? record.env.filter(isRecord) as unknown as EnvBinding[] : undefined;
  const inputs = readLaunchInputs(record.inputs);
  const modelBinding = readModelBinding(record.model_binding ?? record.modelBinding);
  return {
    argv,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    ...(inputs ? { inputs } : {}),
    ...(Number.isSafeInteger(record.timeoutMs) ? { timeoutMs: record.timeoutMs as number } : {}),
    ...(Number.isSafeInteger(record.timeout_ms) ? { timeoutMs: record.timeout_ms as number } : {}),
    ...(asString(record.operationClaimToken) ? { operationClaimToken: asString(record.operationClaimToken)! } : {}),
    ...(asString(record.operation_claim_token) ? { operationClaimToken: asString(record.operation_claim_token)! } : {}),
    ...(asString(record.budgetReservationToken) ? { budgetReservationToken: asString(record.budgetReservationToken)! } : {}),
    ...(asString(record.budget_reservation_token) ? { budgetReservationToken: asString(record.budget_reservation_token)! } : {}),
    ...(modelBinding ? { modelBinding } : {}),
  };
}

function readModelBinding(value: unknown): AssignedWorkLaunchModelBinding | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const argvIndex = record.argv_index ?? record.argvIndex;
  if (!Number.isSafeInteger(argvIndex) || (argvIndex as number) < 0) return undefined;
  const executable = asString(record.executable);
  return {
    argvIndex: argvIndex as number,
    ...(executable ? { executable } : {}),
  };
}

function readDefaultAssignedWorkLaunchTemplate(): AssignedWorkLaunchTemplate | undefined {
  for (const thing of contractThings()) {
    const payload = asRecord(thing.payload);
    if (payload?.kind !== 'assigned-work-launch-template') continue;
    const template = readLaunchTemplate(payload.launch ?? payload.process_launch ?? payload.processLaunch);
    if (template) return template;
  }
  return undefined;
}

function firstText(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const item = asString(value);
    if (item) return item;
  }
  return undefined;
}

function readLaunchInputs(value: unknown): ProcessInputMount[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const inputs = value
    .map((entry): ProcessInputMount | null => {
      const record = asRecord(entry);
      const source = asRecord(record?.source);
      const mountPath = asString(record?.mount_path);
      if (!mountPath || !source || typeof source.kind !== 'string') return null;
      if (source.kind === 'inline') {
        const bytes = asString(source.bytes);
        if (!bytes) return null;
        return {
          mount_path: mountPath,
          source: { kind: 'inline', bytes },
          ...(typeof record?.content_type === 'string' ? { content_type: record.content_type } : {}),
          ...(record?.executable === true ? { executable: true } : {}),
        };
      }
      if (source.kind === 'blob_ref') {
        const hash = asString(source.hash);
        if (!hash) return null;
        return {
          mount_path: mountPath,
          source: { kind: 'blob_ref', hash },
          ...(typeof record?.content_type === 'string' ? { content_type: record.content_type } : {}),
          ...(record?.executable === true ? { executable: true } : {}),
        };
      }
      return null;
    })
    .filter((entry): entry is ProcessInputMount => entry !== null);
  return inputs.length > 0 ? inputs : undefined;
}

function firstTextIn(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!Array.isArray(value)) return undefined;
  return firstText(...value);
}

function decodeProcessSessionReply(reply: unknown): ProcessSessionReply {
  if (reply instanceof Uint8Array) {
    return JSON.parse(TEXT_DECODER.decode(reply)) as ProcessSessionReply;
  }
  if (isRecord(reply) && reply.payload instanceof Uint8Array) {
    return JSON.parse(TEXT_DECODER.decode((reply as ProcessSessionReplyEnvelope).payload)) as ProcessSessionReply;
  }
  return isRecord(reply) ? reply : {};
}

function decodeTargetJsonReply(reply: unknown): Record<string, unknown> {
  const bytes = isRecord(reply) && reply.payload instanceof Uint8Array
    ? (reply as ProcessSessionReplyEnvelope).payload
    : reply instanceof Uint8Array
      ? reply
      : null;
  if (!bytes) return isRecord(reply) ? reply : {};
  const text = TEXT_DECODER.decode(bytes);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

function readU32Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeRecordTableRows(bytes: Uint8Array): (Uint8Array | null)[][] {
  if (TEXT_DECODER.decode(bytes.slice(0, 4)) !== 'RTBL') {
    throw new Error('published-records feed is not a record table');
  }
  const rowCount = readU32Le(bytes, 8);
  const columnCount = readU32Le(bytes, 12);
  const payloadOffset = 16 + rowCount * columnCount * 8;
  const rows: (Uint8Array | null)[][] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row: (Uint8Array | null)[] = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const indexOffset = 16 + (rowIndex * columnCount + columnIndex) * 8;
      const relativeOffset = readU32Le(bytes, indexOffset);
      const length = readU32Le(bytes, indexOffset + 4);
      row.push(length === NULL_CELL_LENGTH
        ? null
        : bytes.slice(payloadOffset + relativeOffset, payloadOffset + relativeOffset + length));
    }
    rows.push(row);
  }
  return rows;
}

export function decodePublishedRecordRowsFromRecordTable(bytes: Uint8Array): PublishedRecordRow[] {
  return decodeRecordTableRows(bytes).map((row) => {
    const address = row[0] ? TEXT_DECODER.decode(row[0]) : undefined;
    const payloadText = row[1] ? TEXT_DECODER.decode(row[1]) : '';
    let payload: unknown = null;
    if (payloadText.trim()) payload = JSON.parse(payloadText) as unknown;
    return {
      ...(address ? { address } : {}),
      payload,
    };
  });
}

function readLaunchTemplateFromProfile(value: unknown): AssignedWorkLaunchTemplate | undefined {
  return readLaunchTemplate(value);
}

export function readInstructionSelectionSnapshot(value: unknown): Readonly<Record<string, unknown>> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.kind !== 'ai-agent-profile.instruction-role-section-selection/current') return null;
  if (typeof record.source_closure_sha256 !== 'string' || !record.source_closure_sha256.startsWith('sha256:')) return null;
  if (typeof record.selection_hash !== 'string' || !record.selection_hash.startsWith('sha256:')) return null;
  return record;
}

export function mountedInputIdentity(input: ProcessInputMount) {
  const sourceHash = input.source.kind === 'blob_ref'
    ? input.source.hash
    : createHash('sha256').update(input.source.bytes, 'utf8').digest('hex');
  return {
    mountPath: input.mount_path,
    contentType: input.content_type ?? null,
    executable: input.executable === true,
    sourceKind: input.source.kind,
    sourceHash,
  };
}

export function buildRuntimeInputProvenance(
  worker: AssignedWorkProfile,
  source: AssignedWorkSourceRecord,
  descriptor: ProcessSessionLaunchDescriptor,
) {
  const instructionSelection = worker.instructionSelection ?? null;
  const sourceObjectiveSha256 = createHash('sha256')
    .update(source.objective ?? '', 'utf8')
    .digest('hex');
  const mountedInputIdentities = (descriptor.process.inputs ?? []).map(mountedInputIdentity);
  const finalInputIdentityDigest = createHash('sha256')
    .update(JSON.stringify({
      workerRef: worker.id,
      instructionSelection,
      sourceObjectiveSha256,
      mountedInputIdentities,
      renderedArgv: descriptor.process.argv,
    }))
    .digest('hex');
  return {
    instructionSelection,
    sourceObjectiveSha256,
    mountedInputIdentities,
    finalInputIdentityDigest,
  };
}

export function readAssignedWorkProfileFromPublishedRows(
  rows: readonly PublishedRecordRow[],
  workerId: string,
): AssignedWorkProfile | null {
  let found: AssignedWorkProfile | null = null;
  for (const row of rows) {
    const payload = asRecord(row.payload);
    if (!payload || payload.kind !== 'ai-agent-profile' || payload.id !== workerId) continue;
    if (payload.status === 'deleted') {
      found = null;
      continue;
    }
    found = {
      id: workerId,
      ...(asString(payload.label) ? { label: asString(payload.label)! } : {}),
      modelRefs: firstTextList(payload.model_refs, payload.modelRefs),
      toolRefs: firstTextList(payload.tool_refs, payload.toolRefs),
      instructionRefs: firstTextList(payload.instruction_refs, payload.instructionRefs),
      memoryRefs: firstTextList(payload.memory_refs, payload.memoryRefs),
      ...(readInstructionSelectionSnapshot(payload.instruction_selection ?? payload.instructionSelection)
        ? { instructionSelection: readInstructionSelectionSnapshot(payload.instruction_selection ?? payload.instructionSelection)! }
        : {}),
      ...(firstText(payload.execution_contract, payload.executionContract)
        ? { executionContract: firstText(payload.execution_contract, payload.executionContract) }
        : {}),
      ...(readLaunchTemplateFromProfile(payload.process_launch ?? payload.processLaunch ?? payload.launch)
        ? { processLaunch: readLaunchTemplateFromProfile(payload.process_launch ?? payload.processLaunch ?? payload.launch)! }
        : {}),
    };
  }
  return found;
}

export function mergeAssignedWorkProfile(
  requested: AssignedWorkProfile,
  resolved: AssignedWorkProfile | null,
): AssignedWorkProfile {
  if (!resolved) return requested;
  return {
    id: requested.id,
    label: requested.label ?? resolved.label,
    modelRefs: (requested.modelRefs?.length ? requested.modelRefs : resolved.modelRefs) ?? [],
    toolRefs: (requested.toolRefs?.length ? requested.toolRefs : resolved.toolRefs) ?? [],
    instructionRefs: (requested.instructionRefs?.length ? requested.instructionRefs : resolved.instructionRefs) ?? [],
    memoryRefs: (requested.memoryRefs?.length ? requested.memoryRefs : resolved.memoryRefs) ?? [],
    instructionSelection: requested.instructionSelection ?? resolved.instructionSelection,
    executionContract: requested.executionContract ?? resolved.executionContract,
    processLaunch: requested.processLaunch ?? requested.process_launch ?? requested.launch ?? resolved.processLaunch ?? resolved.process_launch ?? resolved.launch,
  };
}

export function resolveAssignedWorkLaunchInputFromPublishedRows(
  input: AssignedWorkLaunchInput,
  rows: readonly PublishedRecordRow[],
): AssignedWorkLaunchInput {
  const resolved = readAssignedWorkProfileFromPublishedRows(rows, input.worker.id);
  return {
    ...input,
    worker: mergeAssignedWorkProfile(input.worker, resolved),
  };
}

async function readPublishedRecords(
  send: TargetRequestSender = sendRequestToBitfieldTarget as TargetRequestSender,
): Promise<PublishedRecordRow[]> {
  const reply = await send({
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_READ_CURRENT_OPERATION,
      address_label: PUBLISHED_RECORDS_ADDRESS_LABEL,
    },
  });
  const result = decodeTargetJsonReply(reply);
  if (result.found !== true) return [];
  const payloadBase64 = asString(result.payload_base64);
  if (!payloadBase64) return [];
  return decodePublishedRecordRowsFromRecordTable(decodeBase64Bytes(payloadBase64));
}

export async function resolveAssignedWorkLaunchInput(
  input: AssignedWorkLaunchInput,
  send: TargetRequestSender = sendRequestToBitfieldTarget as TargetRequestSender,
): Promise<AssignedWorkLaunchInput> {
  const rows = await readPublishedRecords(send);
  return resolveAssignedWorkLaunchInputFromPublishedRows(input, rows);
}

function stringifyList(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n');
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function assignedWorkPrompt(source: AssignedWorkSourceRecord, worker: AssignedWorkProfile): string {
  const lines = [
    `Source: ${source.title || source.id}`,
    source.objective ? `Objective: ${source.objective}` : '',
    source.acceptanceCriteria ? `Acceptance criteria:\n${stringifyList(source.acceptanceCriteria)}` : '',
    source.attachments ? `Attachments:\n${stringifyList(source.attachments)}` : '',
    source.proofLinks ? `Proof links:\n${stringifyList(source.proofLinks)}` : '',
    source.effectBoundary ? `Effect boundary (hard limit): ${source.effectBoundary}` : '',
    worker.executionContract ? `Execution contract: ${worker.executionContract}` : '',
    `Assigned worker: ${worker.label || worker.id}`,
  ];
  return lines.filter(Boolean).join('\n\n');
}

// `mintId` is the VALUE, required, never an optional context with a default: the
// caller answers where identity comes from. Its only production caller is the
// `start-assigned-record-work-session` target below, which receives the runtime
// context and derives the minter from the entropy the engine recorded on the
// request, so a replay of the same log names the same work source.
export function buildAssignedWorkLaunchInputFromVisualDatabaseAction(
  payload: AssignedRecordWorkActionPayload,
  mintId: () => string,
): AssignedWorkLaunchInput {
  const input = asRecord(payload.input) ?? {};
  const record = asRecord(input.record) ?? {};
  const workerRef = firstText(
    input.worker,
    input.worker_ref,
    input.agent,
    input.assignee,
    input.assigned_to,
    firstTextIn(record.assigned_to),
    firstTextIn(record.assignees),
  );
  if (!workerRef) throw new Error('Assigned work launch requires selected worker');

  const sourceId = firstText(record.address, input.source_ref, input.record_address, input.project_id, input.record_id, input.task_id)
    ?? `source-record:${mintId()}`;
  const title = firstText(input.title, input.record_title, record.title, record.id, input.task_number) ?? sourceId;
  const objective = firstText(input.objective, input.message, input.detail, record.body, record.description, title);
  const processLaunch = readLaunchTemplate(input.process_launch ?? input.processLaunch ?? input.launch);
  const fallbackLaunchTemplate = readDefaultAssignedWorkLaunchTemplate();
  if (!processLaunch && !fallbackLaunchTemplate) {
    throw new Error('Process Session requires an owner-declared assigned work launch template');
  }

  const worker: AssignedWorkProfile = {
    id: workerRef,
    ...(firstText(input.worker_label, input.agent_label, input.assignee_label)
      ? { label: firstText(input.worker_label, input.agent_label, input.assignee_label) }
      : {}),
    modelRefs: firstTextList(input.model ? [input.model] : [], input.model_refs, input.modelRefs),
    toolRefs: firstTextList(input.tool_refs, input.toolRefs),
    instructionRefs: firstTextList(input.instruction_refs, input.instructionRefs),
    memoryRefs: firstTextList(input.memory_refs, input.memoryRefs),
    ...(processLaunch ? { processLaunch } : {}),
  };

  return {
    source: {
      id: sourceId,
      owner: firstText(input.source_owner, input.owner_package, 'visual-database'),
      kind: firstText(input.source_kind, input.record_kind, record.kind, 'record'),
      title,
      objective,
      acceptanceCriteria: input.acceptance_criteria,
      assignedTo: [workerRef],
      attachments: input.attachments ?? record.attachments,
      proofLinks: input.proof_links ?? record.proof_links,
      contextDescriptorRefs: textList(input.context_descriptor_refs),
      proofSinkRefs: textList(input.proof_sink_refs),
      state: firstText(input.source_state, input.status, record.state, record.status),
    },
    worker,
    ...(fallbackLaunchTemplate ? { fallbackLaunchTemplate } : {}),
    claimToken: firstText(input.claim_token),
    budgetReservationToken: firstText(input.budget_reservation_token),
    correlationRef: firstText(input.correlation_ref),
  };
}

function templateVariables(input: AssignedWorkLaunchInput): Record<string, string> {
  const prompt = assignedWorkPrompt(input.source, input.worker);
  return {
    'agent.id': input.worker.id,
    'agent.label': input.worker.label ?? input.worker.id,
    'worker.id': input.worker.id,
    'worker.label': input.worker.label ?? input.worker.id,
    'source.id': input.source.id,
    'source.title': input.source.title ?? input.source.id,
    'source.objective': input.source.objective ?? '',
    'source.prompt': prompt,
    'team.id': input.team?.id ?? '',
    'team.label': input.team?.label ?? input.team?.id ?? '',
  };
}

function applyTemplate(value: string, variables: Record<string, string>): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (_match, rawKey: string) => variables[rawKey.trim()] ?? '');
}

function renderEnvBindings(bindings: readonly EnvBinding[] | undefined, variables: Record<string, string>): EnvBinding[] {
  return (bindings ?? []).map((binding) => {
    if (binding.kind !== 'literal') return binding;
    return { ...binding, value: applyTemplate(binding.value, variables) };
  });
}

export function sourceIsAssignedToWorker(source: AssignedWorkSourceRecord, worker: AssignedWorkProfile): boolean {
  return textList(source.assignedTo).includes(worker.id);
}

export function buildAssignedWorkLaunchDescriptor(input: AssignedWorkLaunchInput): ProcessSessionLaunchDescriptor {
  const launch = input.launchTemplate ?? input.worker.processLaunch ?? input.worker.process_launch ?? input.worker.launch ?? input.fallbackLaunchTemplate;
  if (!launch) throw new Error(`No process launch template for ${input.worker.id}`);
  const variables = templateVariables(input);
  return renderProcessSessionLaunchDescriptor({
    argv: launch.argv.map((entry) => applyTemplate(entry, variables)),
    cwd: launch.cwd ?? { kind: 'literal', value: '.', inert: true },
    env: renderEnvBindings(launch.env, variables),
    inputs: launch.inputs ? [...launch.inputs] : [],
    timeoutMs: launch.timeoutMs ?? PROCESS_SESSION_ROUTE.timeoutMs,
  });
}

export function buildAssignedWorkTeamLaunchDescriptors(input: {
  source: AssignedWorkSourceRecord;
  team: AssignedWorkTeamRecord;
  workers: readonly AssignedWorkProfile[];
  launchTemplate?: AssignedWorkLaunchTemplate;
}): ProcessSessionLaunchDescriptor[] {
  const byId = new Map(input.workers.map((profile) => [profile.id, profile]));
  const memberRefs = input.team.launchPolicy === 'first-available'
    ? input.team.memberRefs.slice(0, 1)
    : input.team.memberRefs;
  return memberRefs.map((memberRef) => {
    const worker = byId.get(memberRef);
    if (!worker) throw new Error(`Missing worker profile for team member ${memberRef}`);
    return buildAssignedWorkLaunchDescriptor({
      source: input.source,
      worker,
      team: input.team,
      launchTemplate: input.launchTemplate,
    });
  });
}

export function buildStartAssignedWorkSessionRequest(input: AssignedWorkLaunchInput) {
  const launch = input.launchTemplate
    ?? input.worker.processLaunch
    ?? input.worker.process_launch
    ?? input.worker.launch
    ?? input.fallbackLaunchTemplate;
  const idempotencyKey = firstText(
    input.claimToken,
    launch?.operationClaimToken,
    input.correlationRef,
  );
  return buildProcessSessionStartRequest(buildAssignedWorkLaunchDescriptor(input), {
    target: PROCESS_SESSION_ROUTE.target,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

export function buildStopAssignedWorkSessionRequest(sessionId: string) {
  return {
    target: PROCESS_SESSION_ROUTE.target,
    payload: {
      operation: 'append_session_command',
      session_id: sessionId,
      command: { kind: 'end_session' },
    },
  };
}

export async function startAssignedWorkSessionWithSender(
  input: AssignedWorkLaunchInput,
  send: TargetRequestSender,
): Promise<AssignedWorkSessionStartResult> {
  const resolvedInput = await resolveAssignedWorkLaunchInput(input, send);
  const request = buildStartAssignedWorkSessionRequest(resolvedInput);
  const reply = await send(request);
  const result = decodeProcessSessionReply(reply);
  if (result.result !== 'session_started') {
    throw new Error(asString(result.reason) ?? 'Failed to start assigned work session');
  }
  const sessionId = asString(result.session_id) ?? asString(asRecord(result.snapshot)?.session_id);
  if (!sessionId) throw new Error('process-session returned no session_id');
  const eventFeedAddress = asString(asRecord(result.snapshot)?.event_feed_address);
  return {
    eventFeedAddress,
    sessionId,
    sourceRef: resolvedInput.source.id,
    teamRef: resolvedInput.team?.id ?? null,
    workerRef: resolvedInput.worker.id,
    runtimeProvenance: {
      workerRef: resolvedInput.worker.id,
      workerModelRefs: [...(resolvedInput.worker.modelRefs ?? [])],
      renderedArgv: [...request.payload.descriptor.process.argv],
      ...buildRuntimeInputProvenance(resolvedInput.worker, resolvedInput.source, request.payload.descriptor),
    },
  };
}

export function startAssignedWorkSession(input: AssignedWorkLaunchInput): Promise<AssignedWorkSessionStartResult> {
  return startAssignedWorkSessionWithSender(input, sendRequestToBitfieldTarget as TargetRequestSender);
}

function requiredReplyRecord(reply: unknown, label: string): Record<string, unknown> {
  const decoded = decodeTargetJsonReply(reply);
  if (!isRecord(decoded)) throw new Error(`${label} returned no object`);
  return decoded;
}

function requiredWorkflowOutputRecord(reply: unknown, label: string): Record<string, unknown> {
  const decoded = requiredReplyRecord(reply, label);
  const output = decoded.output ?? decoded;
  if (!isRecord(output)) throw new Error(`${label} returned no output object`);
  return output;
}

function requiredReplyText(value: unknown, label: string): string {
  const text = asString(value);
  if (!text) throw new Error(`${label} must be a non-empty string`);
  return text;
}

function decodeOwnerRecordPayload(reply: unknown, addressRef: string): Record<string, unknown> {
  const result = requiredReplyRecord(reply, 'owner record read');
  if (result.found !== true) throw new Error(`owner record not found: ${addressRef}`);
  if (isRecord(result.payload)) return result.payload;
  const valueJson = asString(result.value_json);
  if (valueJson) {
    const parsed = JSON.parse(valueJson) as unknown;
    if (isRecord(parsed)) return parsed;
  }
  const payloadBase64 = asString(result.payload_base64);
  if (payloadBase64) {
    const parsed = JSON.parse(TEXT_DECODER.decode(decodeBase64Bytes(payloadBase64))) as unknown;
    if (isRecord(parsed)) return parsed;
  }
  throw new Error(`owner record has no object payload: ${addressRef}`);
}

function assertSafeIntegerCost(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('authorized assigned work estimated_cost must be a non-negative safe integer');
  }
}

function readOwnerAssignedWorkSource(payload: Record<string, unknown>, sourceRecordRef: string): AssignedWorkSourceRecord {
  const record = asRecord(payload.record) ?? payload;
  const assignedTo = firstTextList(
    record.assignedTo,
    record.assigned_to,
    record.assignees,
    record.assignee_refs,
    record.worker_refs,
  );
  const scalarAssignee = firstText(record.worker_ref, record.agent, record.assignee);
  if (scalarAssignee && !assignedTo.includes(scalarAssignee)) assignedTo.push(scalarAssignee);
  if (assignedTo.length === 0) throw new Error('owner source record has no assigned worker');
  return {
    id: sourceRecordRef,
    owner: firstText(record.owner, record.source_owner),
    kind: firstText(record.kind, record.record_kind, 'record'),
    title: firstText(record.title, record.label, record.name, sourceRecordRef),
    objective: firstText(record.objective, record.detail, record.description, record.body),
    acceptanceCriteria: record.acceptanceCriteria ?? record.acceptance_criteria,
    assignedTo,
    attachments: record.attachments,
    proofLinks: record.proofLinks ?? record.proof_links,
    contextDescriptorRefs: firstTextList(record.contextDescriptorRefs, record.context_descriptor_refs),
    proofSinkRefs: firstTextList(record.proofSinkRefs, record.proof_sink_refs),
    ...(Number.isSafeInteger(record.estimatedCost) ? { estimatedCost: record.estimatedCost as number } : {}),
    ...(Number.isSafeInteger(record.estimated_cost) ? { estimatedCost: record.estimated_cost as number } : {}),
    ...(firstText(record.walletRef, record.wallet_ref) ? { walletRef: firstText(record.walletRef, record.wallet_ref) } : {}),
    ...(firstText(record.effectBoundary, record.effect_boundary) ? { effectBoundary: firstText(record.effectBoundary, record.effect_boundary) } : {}),
    state: firstText(record.state, record.status),
    ...(record.execution_preconditions !== undefined
      ? { executionPreconditions: record.execution_preconditions as AssignedWorkSourceRecord['executionPreconditions'] }
      : {}),
  };
}

function readOwnerAssignedWorkProfile(payload: Record<string, unknown>, workerRecordRef: string): AssignedWorkProfile {
  const profile = readAssignedWorkProfileFromPublishedRows([{ address: workerRecordRef, payload }], asString(payload.id) ?? '');
  if (!profile) throw new Error(`worker owner record is not an active ai-agent-profile: ${workerRecordRef}`);
  if (payload.status !== 'available') {
    throw new Error(`worker owner record is not available: ${workerRecordRef}`);
  }
  const declaredInstructionSelection = payload.instruction_selection ?? payload.instructionSelection;
  if (declaredInstructionSelection !== undefined && !profile.instructionSelection) {
    throw new Error(`worker owner record declares an invalid instruction_selection snapshot: ${workerRecordRef}`);
  }
  return profile;
}

function assertOwnerProfileLaunchMatchesDeclaredModel(worker: AssignedWorkProfile): AssignedWorkLaunchTemplate {
  const launch = worker.processLaunch ?? worker.process_launch ?? worker.launch;
  if (!launch) {
    throw new Error(`authorized assigned work requires an owner-declared process launch: ${worker.id}`);
  }
  const declaredModels = textList(worker.modelRefs).map((ref) => ref.replace(/^ai-model-descriptor:/, ''));
  if (declaredModels.length === 0) {
    throw new Error(`authorized assigned work profile declares no model: ${worker.id}`);
  }
  const binding = launch.modelBinding;
  if (!binding) {
    throw new Error(
      `worker process launch declares no model binding, so the launched model cannot be proven: ${worker.id}. `
      + 'Add model_binding.argv_index (the argv position holding the model id) to the launch template, '
      + 'and model_binding.executable when the launcher also pins its binary.',
    );
  }
  const launchedModel = launch.argv[binding.argvIndex];
  if (!launchedModel || !declaredModels.includes(launchedModel)) {
    throw new Error(`worker process launch model does not match its owner-declared model: ${worker.id}`);
  }
  if (binding.executable !== undefined && launch.argv[0]?.split('/').pop() !== binding.executable) {
    throw new Error(`worker process launch executable does not match its owner-declared launcher: ${worker.id}`);
  }
  return launch;
}

/**
 * One fail-closed coordinator path. Every trust decision comes from an owner
 * reply in this call; only the final process launch follows. The budget
 * reservation ref becomes the process-session idempotency key, fencing one
 * approved reservation to one launch request instead of accepting an unused
 * caller token.
 */
async function verifyExecutionPreconditions(source: AssignedWorkSourceRecord, send: TargetRequestSender): Promise<void> {
  const conditions = source.executionPreconditions;
  if (conditions === undefined) return;
  if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > 16) {
    throw new Error('assigned work execution conditions are invalid');
  }
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('assigned work execution condition has an invalid value');
    }
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw new Error('assigned work execution condition has an invalid value');
    return encoded;
  };
  const permissionDeadlines: number[] = [];
  for (const condition of conditions) {
    if (!isRecord(condition) || typeof condition.record_ref !== 'string'
      || !condition.record_ref || condition.record_ref.length > 512
      || (condition.address_mode !== undefined
        && condition.address_mode !== 'identity_text' && condition.address_mode !== 'label_hash')
      || !Array.isArray(condition.path) || condition.path.length > 16
      || !condition.path.every(part => typeof part === 'string' && part.length > 0)
      || !Object.prototype.hasOwnProperty.call(condition, 'expected')) {
      throw new Error('assigned work execution conditions are invalid');
    }
    const expected = canonical(condition.expected);
    if (expected.length > 32768) throw new Error('assigned work execution condition exceeds its bound');
    const reply = await send({ target: ENGINE_OPERATION_LABEL_TARGET, payload: {
      operation_label: ENGINE_READ_CURRENT_OPERATION, address_label: condition.record_ref,
      address_mode: condition.address_mode ?? 'identity_text',
    } });
    let actual: unknown = decodeOwnerRecordPayload(reply, condition.record_ref);
    if (condition.path.length === 0 && isRecord(actual) && actual.kind === 'permission_lease'
      && actual.expires_at !== undefined && actual.expires_at !== null) {
      if (typeof actual.expires_at !== 'string' || !actual.expires_at.trim()
        || actual.expires_at !== actual.expires_at.trim()) {
        throw new Error('assigned work permission expiry is invalid');
      }
      const deadline = Date.parse(actual.expires_at);
      if (!Number.isFinite(deadline)) throw new Error('assigned work permission expiry is invalid');
      permissionDeadlines.push(deadline);
    }
    for (const part of condition.path) actual = isRecord(actual) ? actual[part] : undefined;
    if (actual === undefined || canonical(actual) !== expected) {
      throw new Error('assigned work execution condition is no longer satisfied');
    }
  }
  if (permissionDeadlines.length > 0) {
    const requestRef = `process-session:execution-preconditions:${createHash('sha256').update(source.id).digest('hex')}`;
    const time = requiredReplyRecord(await send({ target: AUTHORIZATION_TIME_TARGET,
      payload: { request_ref: requestRef } }), 'authorization time');
    if (!Number.isSafeInteger(time.now_ms) || Number(time.now_ms) < 0) {
      throw new Error('assigned work authorization time is invalid');
    }
    if (permissionDeadlines.some(deadline => Number(time.now_ms) >= deadline)) {
      throw new Error('assigned work permission expired before process dispatch');
    }
  }
}

export async function startAuthorizedAssignedWorkSessionWithSender(
  input: AuthorizedAssignedWorkInput,
  send: TargetRequestSender,
): Promise<AuthorizedAssignedWorkResult> {
  if (input.workerRecordAddressMode !== undefined
    && input.workerRecordAddressMode !== 'identity_text' && input.workerRecordAddressMode !== 'label_hash') {
    throw new Error('worker record address mode is invalid');
  }
  if (input.toolRecordAddressMode !== undefined
    && input.toolRecordAddressMode !== 'identity_text' && input.toolRecordAddressMode !== 'label_hash') {
    throw new Error('tool record address mode is invalid');
  }
  const [sourceReply, workerReply] = await Promise.all([
    send({
      target: ENGINE_OPERATION_LABEL_TARGET,
      payload: {
        operation_label: ENGINE_READ_CURRENT_OPERATION,
        address_label: input.sourceRecordRef,
        address_mode: 'identity_text',
      },
    }),
    send({
      target: ENGINE_OPERATION_LABEL_TARGET,
      payload: {
        operation_label: ENGINE_READ_CURRENT_OPERATION,
        address_label: input.workerRecordRef,
        address_mode: input.workerRecordAddressMode ?? 'identity_text',
      },
    }),
  ]);
  const source = readOwnerAssignedWorkSource(decodeOwnerRecordPayload(sourceReply, input.sourceRecordRef), input.sourceRecordRef);
  const worker = readOwnerAssignedWorkProfile(decodeOwnerRecordPayload(workerReply, input.workerRecordRef), input.workerRecordRef);
  const ownerLaunchTemplate = assertOwnerProfileLaunchMatchesDeclaredModel(worker);
  const resolved: AssignedWorkLaunchInput = {
    source,
    worker,
    launchTemplate: ownerLaunchTemplate,
  };
  if (!sourceIsAssignedToWorker(resolved.source, resolved.worker)) {
    throw new Error('assigned work source is not assigned to the selected worker');
  }
  await verifyExecutionPreconditions(source, send);
  if (!input.toolRecordRef.startsWith(TOOL_RECORD_PREFIX)) {
    throw new Error('toolRecordRef must name an ai-tool-catalog owner record');
  }
  const toolReply = await send({
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_READ_CURRENT_OPERATION,
      address_label: input.toolRecordRef,
      address_mode: input.toolRecordAddressMode ?? 'identity_text',
    },
  });
  const tool = decodeOwnerRecordPayload(toolReply, input.toolRecordRef);
  const toolRef = requiredReplyText(tool.id, 'tool.id');
  if (tool.kind !== 'ai-tool-descriptor' || tool.status !== 'active') {
    throw new Error('tool catalog owner record does not prove the requested active tool');
  }
  if (!resolved.worker.toolRefs?.includes(toolRef)) {
    throw new Error('owner-resolved worker profile does not include the requested tool');
  }
  const handlerRef = requiredReplyText(tool.handler_ref, 'tool.handler_ref');
  if (handlerRef !== PROCESS_SESSION_ROUTE.target) {
    throw new Error('tool handler is not bound to the configured process-session owner target');
  }
  const permissionCapabilityRef = requiredReplyText(
    tool.permission_capability_ref,
    'tool.permission_capability_ref',
  );
  const guardRequest = {
    schema: 'ai-action-guard-policy-evaluation-request/v2' as const,
    request_ref: `guard:${resolved.source.id}:${resolved.worker.id}:${toolRef}`,
    action_ref: handlerRef,
    subject_ref: requiredReplyText(tool.guard_subject_ref, 'tool.guard_subject_ref'),
    guard_limit_ref: requiredReplyText(tool.guard_limit_ref, 'tool.guard_limit_ref'),
    guard_state_ref: requiredReplyText(tool.guard_state_ref, 'tool.guard_state_ref'),
  };
  const guard = requiredReplyRecord(await send({ target: GUARD_POLICY_TARGET, payload: guardRequest }), 'guard policy');
  if (guard.allowed !== true || guard.action_ref !== handlerRef || guard.subject_ref !== guardRequest.subject_ref) {
    throw new Error(`guard policy denied assigned work: ${asString(guard.reason_code) ?? 'invalid receipt'}`);
  }
  const guardBasisRef = requiredReplyText(guard.basis_ref, 'guard.basis_ref');

  const permissionRequest = {
    capability_ref: permissionCapabilityRef,
    obligation_where: [
      { field: 'kind', eq: 'capability-obligation' },
      { field: 'capability_ref', eq: permissionCapabilityRef },
    ],
    measure_where: [{ field: 'kind', eq: 'measure.fact' }],
  };
  const permission = requiredWorkflowOutputRecord(await send({
    target: WORKFLOW_TARGET,
    payload: {
      operation: 'execute_definition',
      definition_id: PERMISSION_DEFINITION,
      include_output: true,
      include_steps: false,
      input: permissionRequest,
    },
  }), 'permission lease');
  const verdicts = Array.isArray(permission.verdicts) ? permission.verdicts.filter(isRecord) : [];
  if (
    permission.kind !== 'obligation-decision'
    || permission.allowed !== true
    || permission.capability_ref !== permissionCapabilityRef
    || verdicts.length === 0
    || verdicts.some(verdict => !asString(verdict.obligation_ref) || verdict.satisfied !== true)
  ) {
    throw new Error('permission lease did not prove at least one satisfied owner obligation');
  }
  const permissionBasisRefs = textList(permission.basis);

  assertSafeIntegerCost(resolved.source.estimatedCost as number);
  const operationRef = resolved.source.id;
  const budgetIdempotencyKey = `assigned-work:${resolved.source.id}:${resolved.worker.id}:${toolRef}`;
  const budget = requiredWorkflowOutputRecord(await send({
    target: WORKFLOW_TARGET,
    payload: {
      operation: 'execute_definition',
      definition_id: BUDGET_DEFINITION,
      include_output: true,
      include_steps: false,
      input: {
        operation_ref: operationRef,
        estimated_cost: resolved.source.estimatedCost,
        agent_id: resolved.worker.id,
        idempotency_key: budgetIdempotencyKey,
        ...(resolved.source.walletRef
          ? { wallet_ref: resolved.source.walletRef }
          : {}),
      },
    },
  }), 'budget gate');
  if (budget.approved !== true) throw new Error(`budget gate denied assigned work: ${asString(budget.reason) ?? 'invalid receipt'}`);
  const budgetCheckRef = requiredReplyText(budget.check_ref, 'budget.check_ref');
  const budgetReservationRef = requiredReplyText(budget.reservation_ref, 'budget.reservation_ref');

  // Policy may have changed while the guard/permission/budget owners replied.
  // Recheck immediately before dispatch; the process owner still owns containment.
  await verifyExecutionPreconditions(source, send);

  const processRequest = buildStartAssignedWorkSessionRequest({
    ...resolved,
    claimToken: budgetReservationRef,
    budgetReservationToken: undefined,
  });
  const runtimeInputProvenance = buildRuntimeInputProvenance(
    resolved.worker,
    resolved.source,
    processRequest.payload.descriptor,
  );
  if (processRequest.payload.idempotency_key !== budgetReservationRef) {
    throw new Error('budget reservation was not consumed as the process idempotency fence');
  }
  const result = decodeProcessSessionReply(await send(processRequest));
  if (result.result !== 'session_started') {
    throw new Error(asString(result.reason) ?? 'Failed to start authorized assigned work session');
  }
  const sessionId = asString(result.session_id) ?? asString(asRecord(result.snapshot)?.session_id);
  if (!sessionId) throw new Error('process-session returned no session_id');
  const eventFeedAddress = asString(asRecord(result.snapshot)?.event_feed_address);
  return {
    eventFeedAddress,
    sessionId,
    sourceRef: resolved.source.id,
    teamRef: resolved.team?.id ?? null,
    workerRef: resolved.worker.id,
    runtimeProvenance: {
      workerRef: resolved.worker.id,
      workerModelRefs: [...(resolved.worker.modelRefs ?? [])],
      renderedArgv: [...processRequest.payload.descriptor.process.argv],
      ...runtimeInputProvenance,
    },
    authorizationProvenance: {
      toolRecordRef: input.toolRecordRef,
      guardBasisRef,
      permissionBasisRefs,
      budgetCheckRef,
      budgetReservationRef,
      processIdempotencyKey: budgetReservationRef,
    },
  };
}

export function startAuthorizedAssignedWorkSession(input: AuthorizedAssignedWorkInput) {
  return startAuthorizedAssignedWorkSessionWithSender(input, sendRequestToBitfieldTarget as TargetRequestSender);
}

export function startAssignedRecordWorkSession(
  payload: AssignedRecordWorkActionPayload,
  context?: BitfieldRuntimeContext,
): Promise<AssignedWorkSessionStartResult> {
  return startAssignedWorkSession(
    buildAssignedWorkLaunchInputFromVisualDatabaseAction(
      payload,
      createTrustedRuntimeIdMinter(context),
    ),
  );
}

export async function stopAssignedWorkSession(sessionId: string): Promise<void> {
  const reply = await sendRequestToBitfieldTarget(buildStopAssignedWorkSessionRequest(sessionId));
  const result = decodeProcessSessionReply(reply);
  if (result.result === 'command_rejected' && text(result.reason) !== 'session does not exist') {
    throw new Error(asString(result.reason) ?? 'Failed to stop assigned work session');
  }
}
