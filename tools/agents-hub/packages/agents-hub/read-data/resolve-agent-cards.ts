//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure join of blind published-record feeds into agent card view models. No
// React, no reads, no writes — feeds come in as parameters, view models come
// out. All capability/icon vocabulary arrives as data from the package's own
// config record; nothing here names a vendor or a capability.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure function of its inputs — deterministic, testable in isolation
// 2. Zero imports from other feature packages — record shapes are decoded
//    blind from {address, payload} rows
// 3. Society vocabulary (vendors, capability names, icons) is parameter data
//
// =============================================================================

export type PublishedRecordRow = {
  address?: string;
  payload?: unknown;
};

export type AgentProfileRecord = {
  id: string;
  label?: string;
  description?: string;
  status?: string;
  model_refs: string[];
  tool_refs: string[];
  instruction_refs: string[];
  instruction_selection?: Record<string, unknown>;
  memory_refs: string[];
  guard_ref?: string;
  process_launch?: Record<string, unknown>;
  /** The feed address this record was read from. Writes go back to THIS
   *  address verbatim — writing to a re-derived label creates a duplicate
   *  record instead of editing the original ("edits don't stick"). */
  source_address?: string;
};

export type ModelDescriptorRecord = {
  id: string;
  display_name?: string;
  model_id?: string;
  provider_ref?: string;
  /** Runtimes this model can execute on, as published by its catalog owner. */
  runtime_refs: string[];
  capabilities: string[];
  /** Feed address this record was read from; delete writes a tombstone here. */
  source_address?: string;
};

export type InstructionBlockRecord = {
  id: string;
  label?: string;
  body?: string;
  status?: string;
  source_address?: string;
};

export type ToolDescriptorRecord = {
  id: string;
  label?: string;
  description?: string;
  status?: string;
  source_address?: string;
};

export type ExecutionRunRecord = {
  id: string;
  agent_ref?: string;
  total_cost?: number;
  total_units?: number;
  status?: string;
};

export type ConversationSessionRow = {
  recordId: string;
  sessionId?: string;
  agentId?: string;
  /** Human title of the session, when the source named one. */
  title?: string;
  /** Model that ran the session (display string already). */
  model?: string;
  /** The opening ask — what the session was for. */
  prompt?: string;
  /** Project the session belonged to (human name, never a slug/id). */
  projectName?: string;
  startedAt?: string;
  lastActivityAt?: string;
  messageCount?: number;
};

/** How a placement is shown: the icon and the words. The `unknown` row paints a model whose
 *  runtime nobody published, so an unpublished fact reads as unpublished, never as a guess. */
export type PlacementMark = { icon: string; label: string };

export type CapabilityIconConfig = {
  icons: { capability: string; icon: string; label: string }[];
  vendor_fallback: { vendor: string; capabilities: string[] }[];
  /** `deployment_class` key, as the runtime owner publishes it, to its mark. */
  placement_marks: { deployment_class: string; mark: PlacementMark }[];
  unknown_placement: PlacementMark;
};

/** A published `ai-model-runtime-descriptor`: the thing a model actually executes on.
 *  `deployment_class` is the runtime owner's own word for where that runtime lives. */
export type ModelRuntimeRecord = {
  runtime_id: string;
  deployment_class?: string;
};

export type CapabilityIconItem = {
  capability: string;
  icon: string;
  label: string;
};

export interface AgentCardViewModel {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  modelLabel: string;
  vendor: string;
  /** Where the agent's model runs, resolved through its runtime's published class. */
  placement: PlacementMark;
  capabilityIcons: CapabilityIconItem[];
  toolLabels: string[];
  instructionBlocks: { id: string; label: string; missing: boolean }[];
  runCount: number;
  totalCost: number;
  totalUnits: number;
  conversationCount: number;
  lastConversationAt: string;
  profile: AgentProfileRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Blind decoders over the published-records feed (kind-discriminated payloads)
// ---------------------------------------------------------------------------

export function readAgentProfiles(rows: readonly PublishedRecordRow[]): AgentProfileRecord[] {
  const byId = new Map<string, AgentProfileRecord>();
  for (const row of rows) {
    const payload = row.payload;
    if (!isRecord(payload) || payload.kind !== 'ai-agent-profile') continue;
    const id = text(payload.id);
    if (!id) continue;
    const record: AgentProfileRecord = {
      id,
      ...(text(payload.label) ? { label: text(payload.label) } : {}),
      ...(text(payload.description) ? { description: text(payload.description) } : {}),
      ...(text(payload.status) ? { status: text(payload.status) } : {}),
      model_refs: textList(payload.model_refs),
      tool_refs: textList(payload.tool_refs),
      instruction_refs: textList(payload.instruction_refs),
      ...(isRecord(payload.instruction_selection)
        ? { instruction_selection: { ...payload.instruction_selection } }
        : {}),
      memory_refs: textList(payload.memory_refs),
      ...(text(payload.guard_ref) ? { guard_ref: text(payload.guard_ref) } : {}),
      ...(recordValue(payload.process_launch ?? payload.processLaunch ?? payload.launch)
        ? { process_launch: recordValue(payload.process_launch ?? payload.processLaunch ?? payload.launch) }
        : {}),
      ...(text(row.address) ? { source_address: text(row.address) } : {}),
    };
    // One record per id — the feed is the authority; later rows for the same
    // id supersede earlier ones (an edit written back to the record's own
    // address replays after the seed in the log).
    byId.set(id, record);
  }
  return Array.from(byId.values());
}

export function readModelDescriptors(rows: readonly PublishedRecordRow[]): ModelDescriptorRecord[] {
  return rows.flatMap((row) => {
    const payload = row.payload;
    if (!isRecord(payload) || payload.kind !== 'ai-model-descriptor') return [];
    if (text(payload.status) === 'deleted') return [];
    const id = text(payload.id);
    if (!id) return [];
    return [{
      id,
      ...(text(payload.display_name) ? { display_name: text(payload.display_name) } : {}),
      ...(text(payload.model_id) ? { model_id: text(payload.model_id) } : {}),
      ...(text(payload.provider_ref) ? { provider_ref: text(payload.provider_ref) } : {}),
      runtime_refs: textList(payload.runtime_refs),
      capabilities: textList(payload.capabilities),
      ...(text(row.address) ? { source_address: text(row.address) } : {}),
    }];
  });
}

export function readModelRuntimes(rows: readonly PublishedRecordRow[]): ModelRuntimeRecord[] {
  return rows.flatMap((row) => {
    const payload = row.payload;
    if (!isRecord(payload) || payload.kind !== 'ai-model-runtime-descriptor') return [];
    if (text(payload.status) === 'deleted') return [];
    const runtimeId = text(payload.runtime_id);
    if (!runtimeId) return [];
    return [{
      runtime_id: runtimeId,
      ...(text(payload.deployment_class) ? { deployment_class: text(payload.deployment_class) } : {}),
    }];
  });
}

/** The mark for a model: its first runtime with a published class wins; no runtime, or a class
 *  with no mark row, resolves to the `unknown` row. The resolver never names a class. */
export function resolvePlacement(
  model: ModelDescriptorRecord | undefined,
  runtimeById: ReadonlyMap<string, ModelRuntimeRecord>,
  config: CapabilityIconConfig,
): PlacementMark {
  const markByClass = new Map(config.placement_marks.map((entry) => [entry.deployment_class, entry.mark]));
  for (const ref of model?.runtime_refs ?? []) {
    const runtimeClass = runtimeById.get(ref)?.deployment_class;
    const mark = runtimeClass ? markByClass.get(runtimeClass) : undefined;
    if (mark) return mark;
  }
  return config.unknown_placement;
}

export function readInstructionBlocks(rows: readonly PublishedRecordRow[]): InstructionBlockRecord[] {
  return rows.flatMap((row) => {
    const payload = row.payload;
    if (!isRecord(payload) || payload.kind !== 'ai-instruction-block') return [];
    if (text(payload.status) === 'deleted') return [];
    const id = text(payload.id);
    if (!id) return [];
    return [{
      id,
      ...(text(payload.label) ? { label: text(payload.label) } : {}),
      ...(text(payload.body) ? { body: text(payload.body) } : {}),
      ...(text(payload.status) ? { status: text(payload.status) } : {}),
      ...(text(row.address) ? { source_address: text(row.address) } : {}),
    }];
  });
}

export function readToolDescriptors(rows: readonly PublishedRecordRow[]): ToolDescriptorRecord[] {
  return rows.flatMap((row) => {
    const payload = row.payload;
    if (!isRecord(payload) || payload.kind !== 'ai-tool-descriptor') return [];
    if (text(payload.status) === 'deleted') return [];
    const id = text(payload.id);
    if (!id) return [];
    return [{
      id,
      ...(text(payload.label) ? { label: text(payload.label) } : {}),
      ...(text(payload.description) ? { description: text(payload.description) } : {}),
      ...(text(payload.status) ? { status: text(payload.status) } : {}),
      ...(text(row.address) ? { source_address: text(row.address) } : {}),
    }];
  });
}

export type MemoryRecord = {
  id: string;
  agent_ref?: string;
  label?: string;
  body: string;
  memory_type?: string;
  source_address?: string;
};

export function readMemoryRecords(rows: readonly PublishedRecordRow[]): MemoryRecord[] {
  return rows.flatMap((row) => {
    const payload = row.payload;
    if (!isRecord(payload)) return [];
    if (payload.kind !== 'ai-memory-record' && payload.kind !== 'memory-context-item') return [];
    if (text(payload.status) === 'deleted') return [];
    const id = text(payload.id);
    const body = text(payload.body);
    if (!id || !body) return [];
    return [{
      id,
      ...(text(payload.agent_ref) ? { agent_ref: text(payload.agent_ref) } : {}),
      ...(text(payload.label) ? { label: text(payload.label) } : {}),
      body,
      ...(text(payload.memory_type) ? { memory_type: text(payload.memory_type) } : {}),
      ...(text(row.address) ? { source_address: text(row.address) } : {}),
    }];
  });
}

export type PermissionRow = {
  id: string;
  /** Human label derived from the limited action's name. */
  label: string;
  allowed: boolean;
  /** Plain-language reason shown next to a blocked permission. */
  reason?: string;
  subject_ref?: string;
  /** Address of the governing limit record — delete tombstones the limit. */
  source_address?: string;
};

/** Permission rows from guard records: a limit names what is governed; its
 *  paired state record says whether the door is currently open. Blind to the
 *  guard package — kind-discriminated payloads only. */
export function readPermissionRows(rows: readonly PublishedRecordRow[]): PermissionRow[] {
  const limits = new Map<string, Record<string, unknown>>();
  const states = new Map<string, Record<string, unknown>>();
  const limitAddress = new Map<string, string>();
  for (const row of rows) {
    const payload = row.payload;
    if (!isRecord(payload)) continue;
    if (text(payload.status) === 'deleted') continue;
    const id = text(payload.id);
    if (!id) continue;
    const key = id.split(':').slice(1).join(':') || id;
    if (payload.kind === 'ai-guard-limit') {
      limits.set(key, payload);
      const address = text(row.address);
      if (address) limitAddress.set(key, address);
    }
    if (payload.kind === 'ai-guard-state') states.set(key, payload);
  }
  const keys = new Set([...limits.keys(), ...states.keys()]);
  return Array.from(keys).map((key) => {
    const limit = limits.get(key);
    const state = states.get(key);
    const stateText = state ? text(state.state) : undefined;
    const allowed = stateText === undefined || stateText === 'allowed' || stateText === 'open';
    const actionRef = limit ? text(limit.action_ref) : undefined;
    const label = (actionRef ?? key).split('.').pop()?.replace(/[-_]+/g, ' ') ?? key;
    // Reason is HUMAN PROSE carried on the record (`reason` / `message`),
    // never the machine state token — state tokens drive allowed/blocked
    // only and must not render (the "todo Blocked" leak class).
    const reason = state ? (text(state.reason) ?? text(state.message)) : undefined;
    return {
      id: key,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      allowed,
      ...(!allowed && reason ? { reason } : {}),
      ...(state && text(state.subject_ref) ? { subject_ref: text(state.subject_ref) } : limit && text(limit.subject_ref) ? { subject_ref: text(limit.subject_ref) } : {}),
      ...(limitAddress.get(key) ? { source_address: limitAddress.get(key) } : {}),
    };
  });
}

/** Ids the user removed from the hub for kinds with no writable source record
 *  (runs are real transcripts, runtime memory is live agent state). Delete on
 *  those writes a hide marker instead of destroying the underlying truth; this
 *  reads the active markers so every view can filter them out. One hide list,
 *  every kind filtered the same way (L069). */
export function readHiddenEntityIds(rows: readonly PublishedRecordRow[]): Set<string> {
  const hidden = new Set<string>();
  for (const row of rows) {
    const payload = row.payload;
    if (!isRecord(payload) || payload.kind !== 'agents-hub-hidden-entity') continue;
    if (text(payload.status) === 'deleted') continue;
    const entityId = text(payload.entity_id);
    if (entityId) hidden.add(entityId);
  }
  return hidden;
}

export function readExecutionRuns(rows: readonly PublishedRecordRow[]): ExecutionRunRecord[] {
  return rows
    .map((row) => row.payload)
    .filter(isRecord)
    .filter((payload) => payload.kind === 'ai-execution-run')
    .flatMap((payload) => {
      const id = text(payload.id);
      if (!id) return [];
      return [{
        id,
        ...(text(payload.agent_ref) ? { agent_ref: text(payload.agent_ref) } : {}),
        ...(numberValue(payload.total_cost) !== undefined ? { total_cost: numberValue(payload.total_cost) } : {}),
        ...(numberValue(payload.total_units) !== undefined ? { total_units: numberValue(payload.total_units) } : {}),
        ...(text(payload.status) ? { status: text(payload.status) } : {}),
      }];
    });
}

export function readCapabilityIconConfig(rows: readonly PublishedRecordRow[]): CapabilityIconConfig {
  for (const row of rows) {
    const payload = row.payload;
    if (!isRecord(payload) || payload.kind !== 'agents-hub-capability-icons-config') continue;
    const icons = Array.isArray(payload.icons)
      ? payload.icons.filter(isRecord).flatMap((entry) => {
          const capability = text(entry.capability);
          const icon = text(entry.icon);
          const label = text(entry.label);
          return capability && icon && label ? [{ capability, icon, label }] : [];
        })
      : [];
    const vendorFallback = Array.isArray(payload.vendor_fallback)
      ? payload.vendor_fallback.filter(isRecord).flatMap((entry) => {
          const vendor = text(entry.vendor);
          return vendor ? [{ vendor, capabilities: textList(entry.capabilities) }] : [];
        })
      : [];
    const placementMarks = Array.isArray(payload.placement_marks)
      ? payload.placement_marks.filter(isRecord).flatMap((entry) => {
          const deploymentClass = text(entry.deployment_class);
          const mark = readPlacementMark(entry.mark);
          return deploymentClass && mark ? [{ deployment_class: deploymentClass, mark }] : [];
        })
      : [];
    return {
      icons,
      vendor_fallback: vendorFallback,
      placement_marks: placementMarks,
      unknown_placement: readPlacementMark(payload.unknown_placement) ?? EMPTY_PLACEMENT,
    };
  }
  return { icons: [], vendor_fallback: [], placement_marks: [], unknown_placement: EMPTY_PLACEMENT };
}

const EMPTY_PLACEMENT: PlacementMark = { icon: '', label: '' };

function readPlacementMark(raw: unknown): PlacementMark | undefined {
  if (!isRecord(raw)) return undefined;
  const icon = text(raw.icon);
  const label = text(raw.label);
  return icon && label ? { icon, label } : undefined;
}

/** Provider option records published as data (provider_id/name/vendor/description). */
export type ProviderOptionRecord = {
  provider_id: string;
  name?: string;
  vendor?: string;
  description?: string;
};

export function readProviderOptions(rows: readonly PublishedRecordRow[]): ProviderOptionRecord[] {
  return rows
    .map((row) => row.payload)
    .filter(isRecord)
    .flatMap((payload) => {
      const providerId = text(payload.provider_id);
      const vendor = text(payload.vendor);
      if (!providerId || !vendor) return [];
      return [{
        provider_id: providerId,
        ...(text(payload.name) ? { name: text(payload.name) } : {}),
        vendor,
        ...(text(payload.description) ? { description: text(payload.description) } : {}),
      }];
    });
}

export function decodeConversationSessions(raw: unknown): ConversationSessionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const recordId = text(entry.recordId);
    if (!recordId) return [];
    return [{
      recordId,
      ...(text(entry.sessionId) ? { sessionId: text(entry.sessionId) } : {}),
      ...(text(entry.agentId) ? { agentId: text(entry.agentId) } : {}),
      ...(text(entry.title) ? { title: text(entry.title) } : {}),
      ...(text(entry.model) ? { model: text(entry.model) } : {}),
      ...(text(entry.prompt) ? { prompt: text(entry.prompt) } : {}),
      ...(text(entry.projectName) ? { projectName: text(entry.projectName) } : {}),
      ...(text(entry.startedAt) ? { startedAt: text(entry.startedAt) } : {}),
      ...(text(entry.lastActivityAt) ? { lastActivityAt: text(entry.lastActivityAt) } : {}),
      ...(numberValue(entry.messageCount) !== undefined ? { messageCount: numberValue(entry.messageCount) } : {}),
    }];
  });
}

// ---------------------------------------------------------------------------
// Runtime agent memories — the memories agents WROTE during execution, carried
// as EEAF attribute facts (one row per {subject_id, property_id, value}) on the
// `agent-memories` feed. Blind to the writer: we group rows by subject and read
// the `prop:agent_memory:*` properties. (Distinct from configured memory blocks
// on published-records, which `readMemoryRecords` covers.)
// ---------------------------------------------------------------------------

export type EeafFactRow = {
  subject_id: string;
  property_id: string;
  value?: unknown;
};

export type AgentMemoryFact = {
  id: string;
  account?: string;
  content: string;
  updatedAt?: string;
};

/** Decode the cell_table feed rows ({subject_id, property_id, value}) into a
 *  typed list, dropping rows missing either key. */
export function decodeEeafFactRows(raw: unknown): EeafFactRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const subjectId = text(entry.subject_id);
    const propertyId = text(entry.property_id);
    if (!subjectId || !propertyId) return [];
    return [{ subject_id: subjectId, property_id: propertyId, value: entry.value }];
  });
}

const MEMORY_PROP_PREFIX = 'prop:agent_memory:';

/** Fold EEAF fact rows into one memory per subject. A memory needs `content`;
 *  rows without it (or for other property namespaces) are ignored. */
export function readAgentMemoryFacts(rows: readonly EeafFactRow[]): AgentMemoryFact[] {
  const bySubject = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row.property_id.startsWith(MEMORY_PROP_PREFIX)) continue;
    const key = row.property_id.slice(MEMORY_PROP_PREFIX.length);
    const bag = bySubject.get(row.subject_id) ?? {};
    bag[key] = row.value;
    bySubject.set(row.subject_id, bag);
  }
  return Array.from(bySubject.entries()).flatMap(([id, bag]) => {
    const content = text(bag.content);
    if (!content) return [];
    return [{
      id,
      ...(text(bag.account) ? { account: text(bag.account) } : {}),
      content,
      ...(text(bag.updated_at) ? { updatedAt: text(bag.updated_at) } : {}),
    }];
  });
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" / "4mo ago" — compact, human.
 *  `now` is injectable for deterministic tests. Empty for unparseable/future. */
export function formatRelativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diffMin = Math.floor((now - then) / 60000);
  if (diffMin < 0) return '';
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  return `${Math.floor(diffMo / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// The join: feeds → AgentCardViewModel[]
// ---------------------------------------------------------------------------

export interface ResolveAgentCardsInput {
  publishedRecords: readonly PublishedRecordRow[];
  sessions: readonly ConversationSessionRow[];
}

export function resolveAgentCards(input: ResolveAgentCardsInput): AgentCardViewModel[] {
  const { publishedRecords, sessions } = input;

  const profiles = readAgentProfiles(publishedRecords);
  const models = readModelDescriptors(publishedRecords);
  const blocks = readInstructionBlocks(publishedRecords);
  const tools = readToolDescriptors(publishedRecords);
  const runs = readExecutionRuns(publishedRecords);
  const iconConfig = readCapabilityIconConfig(publishedRecords);
  const providerOptions = readProviderOptions(publishedRecords);
  const runtimes = readModelRuntimes(publishedRecords);

  // Typed flat indexes, O(1) lookups, built once per call (P4)
  const modelById = new Map(models.map((model) => [model.id, model]));
  const runtimeById = new Map(runtimes.map((runtime) => [runtime.runtime_id, runtime]));
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const iconByCapability = new Map(iconConfig.icons.map((icon) => [icon.capability, icon]));
  const fallbackByVendor = new Map(iconConfig.vendor_fallback.map((entry) => [entry.vendor, entry.capabilities]));

  const runsByAgent = new Map<string, ExecutionRunRecord[]>();
  for (const run of runs) {
    if (!run.agent_ref) continue;
    const list = runsByAgent.get(run.agent_ref) ?? [];
    list.push(run);
    runsByAgent.set(run.agent_ref, list);
  }

  const sessionsByAgent = new Map<string, ConversationSessionRow[]>();
  for (const session of sessions) {
    if (!session.agentId) continue;
    const list = sessionsByAgent.get(session.agentId) ?? [];
    list.push(session);
    sessionsByAgent.set(session.agentId, list);
  }

  // Provider resolution is REF-DRIVEN only: the agent's model descriptor
  // names its provider, and the provider's identity is a published
  // `ai-provider-option` row from whichever package authored that ref.
  // Agents without a model show nothing, because falling back to "the
  // primary provider" painted every agent with the same model label (the
  // duplicated-label bug) and lied about unconfigured agents.
  return profiles
    .map((profile) => {
      const model = profile.model_refs.map((ref) => modelById.get(ref)).find(Boolean);
      const providerOption = model?.provider_ref
        ? providerOptions.find((option) => option.provider_id === model.provider_ref)
        : undefined;

      const vendor = providerOption?.vendor ?? '';
      const capabilities = model && model.capabilities.length > 0
        ? model.capabilities
        : (fallbackByVendor.get(vendor) ?? []);
      const capabilityIcons = capabilities
        .map((capability) => iconByCapability.get(capability))
        .filter((icon): icon is CapabilityIconItem => Boolean(icon));

      const agentRuns = runsByAgent.get(profile.id) ?? [];
      const agentSessions = sessionsByAgent.get(profile.id) ?? [];
      const lastConversationAt = agentSessions
        .map((session) => session.lastActivityAt ?? '')
        .sort()
        .at(-1) ?? '';

      const modelLabel = model?.display_name ?? model?.model_id ?? (providerOption?.name ?? '');

      return {
        id: profile.id,
        name: profile.label ?? profile.id,
        description: profile.description ?? '',
        archived: profile.status === 'archived',
        modelLabel,
        vendor,
        placement: resolvePlacement(model, runtimeById, iconConfig),
        capabilityIcons,
        toolLabels: profile.tool_refs
          .map((ref) => toolById.get(ref)?.label)
          .filter((label): label is string => Boolean(label)),
        instructionBlocks: profile.instruction_refs.map((ref) => {
          const block = blockById.get(ref);
          return { id: ref, label: block?.label ?? '', missing: !block };
        }),
        runCount: agentRuns.length,
        totalCost: agentRuns.reduce((sum, run) => sum + (run.total_cost ?? 0), 0),
        totalUnits: agentRuns.reduce((sum, run) => sum + (run.total_units ?? 0), 0),
        conversationCount: agentSessions.length,
        lastConversationAt,
        profile,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** "$0.42" / "$12.30" — plain currency with two decimals; empty for zero. */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return `$${value.toFixed(2)}`;
}

/** "12" / "1.2k" / "3.4M" token-style compact count; empty for zero. */
export function formatUnits(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
