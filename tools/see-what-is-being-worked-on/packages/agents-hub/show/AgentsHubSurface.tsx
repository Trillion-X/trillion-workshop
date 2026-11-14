// packages/agents-hub/show/AgentsHubSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The agents management hub — a master/detail surface. The PERSISTENT LEFT
// COLUMN switches the different stuff (Agents / Models / Tools / Instructions /
// Memory / Runs / Permissions); the main area shows that category's cards, and
// opening an agent shows its full detail INLINE in the same area. This IS the
// landing view — no card-grid-behind-a-popover, no "see everything" gate.
//
// Data: blind published-records feed (kind-discriminated payloads), live
// provider rows, the chat-sessions feed (real executions), and the
// agent-memories EEAF feed — joined by pure decoders into view models. Writes:
// full-record engine write-batch (agent records) and blind workflow dispatch
// (messages). Zero imports from any other feature package.
//
// =============================================================================

import React from 'react';
import { Bot } from 'lucide-react';
import {
  BulkSelectBar,
  Button,
  Card,
  Container,
  EmptyPlaceholder,
  Input,
  NamedIcon,
  SegmentedControl,
  Spinner,
  Text,
} from '@/packages/ui';
import { useBitfieldData } from '@/packages/agents-hub/.bitfield-entry-scope/agents-hub/runtime-kit-react';
import {
  decodeConversationSessions,
  decodeEeafFactRows,
  formatRelativeTime,
  readAgentMemoryFacts,
  readCapabilityIconConfig,
  readInstructionBlocks,
  readMemoryRecords,
  readHiddenEntityIds,
  readModelDescriptors,
  readModelRuntimes,
  readPermissionRows,
  readProviderOptions,
  resolvePlacement,
  readToolDescriptors,
  resolveAgentCards,
  type AgentCardViewModel,
  type AgentProfileRecord,
  type PublishedRecordRow,
} from '@/packages/agents-hub/read-data/resolve-agent-cards';
import { AgentManagerView } from '@/packages/agents-hub/show/AgentManagerView';
import { EntityCard, type EntityCardProps } from '@/packages/agents-hub/show/EntityCard';
import { EntityDetailView, type EntityDetailModel } from '@/packages/agents-hub/show/EntityDetailView';
import {
  archivedCopy,
  blankAgentProfile,
  restoredCopy,
  softDeletePublishedRecords,
  writeAgentProfiles,
  writeHiddenEntity,
} from '@/packages/agents-hub/do-work/agent-record-writes';
import {
  dispatchAgentMessage,
  readMessageDispatchConfig,
} from '@/packages/agents-hub/do-work/dispatch-agent-message';
import { AgentCard } from '@/packages/agents-hub/show/AgentCard';
import { AgentEditView } from '@/packages/agents-hub/show/AgentEditView';


/** Max entity cards rendered at once (Runs can hold thousands of sessions).
 *  The header shows the true total; this only bounds the DOM. */
const ENTITY_RENDER_CAP = 300;

export function readRequestedAgentId(surfaceInput: unknown): string | null {
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return null;
  const value = (surfaceInput as Record<string, unknown>).subject_ref;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function decodePublishedRecordRows(raw: unknown): PublishedRecordRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    // The address is TOP-LEVEL on aggregate rows ({address, payload}) but NESTED
    // under `record` on scoped `record_from_matching_records` json_array rows
    // ({record:{address, source_package}, payload}). Read both so a scoped feed
    // decodes identically to the global aggregate — the L126 scoped-feed migration
    // can repoint this input at a kind-scoped feed with ZERO behaviour change
    // (card sourceAddress / delete keeps working). Aggregate path is unchanged.
    const nestedRecord = row.record && typeof row.record === 'object' && !Array.isArray(row.record)
      ? (row.record as Record<string, unknown>)
      : undefined;
    const address = typeof row.address === 'string'
      ? row.address
      : (nestedRecord && typeof nestedRecord.address === 'string' ? nestedRecord.address : undefined);
    return [{ ...(address ? { address } : {}), payload: row.payload }];
  });
}

type FilterValue = 'active' | 'archived';

/** The persistent left-column switch — every AI building block is one click
 *  from the surface root (the owner's anatomy: the left column IS the main nav). */
type HubView = 'agents' | 'models' | 'tools' | 'instructions' | 'memory' | 'runs' | 'permissions';

const HUB_VIEWS: readonly { id: HubView; label: string; icon: string }[] = [
  { id: 'agents', label: 'Agents', icon: 'Bot' },
  { id: 'models', label: 'Models', icon: 'Cpu' },
  { id: 'tools', label: 'Tools', icon: 'Wrench' },
  { id: 'instructions', label: 'Instructions', icon: 'ListOrdered' },
  { id: 'memory', label: 'Memory', icon: 'Brain' },
  { id: 'runs', label: 'Runs', icon: 'Play' },
  { id: 'permissions', label: 'Permissions', icon: 'ShieldCheck' },
];

/** One building block in any non-agent view — clickable into its detail, with
 *  a writable home (`sourceAddress`) when it can be deleted. Same primitive for
 *  every kind: the card grid renders `card`, opening renders `detail` (L069). */
interface HubEntity {
  id: string;
  card: EntityCardProps;
  detail: EntityDetailModel;
  /** Present → this block has a writable home and can be deleted. */
  sourceAddress?: string;
}

export function AgentsHubSurface({ surfaceInput }: { surfaceInput?: Record<string, unknown> }): React.ReactElement {
  const publishedEntry = useBitfieldData();
  const sessionsEntry = useBitfieldData('chat-sessions');
  const memoryFactsEntry = useBitfieldData('agent-memory-facts');

  const publishedRows = React.useMemo(() => decodePublishedRecordRows(publishedEntry), [publishedEntry]);
  const sessions = React.useMemo(() => decodeConversationSessions(sessionsEntry), [sessionsEntry]);
  const memoryFacts = React.useMemo(() => readAgentMemoryFacts(decodeEeafFactRows(memoryFactsEntry)), [memoryFactsEntry]);

  const cards = React.useMemo(
    () => resolveAgentCards({ publishedRecords: publishedRows, sessions }),
    [publishedRows, sessions],
  );

  const models = React.useMemo(() => readModelDescriptors(publishedRows), [publishedRows]);
  const runtimes = React.useMemo(() => readModelRuntimes(publishedRows), [publishedRows]);
  const runtimeById = React.useMemo(
    () => new Map(runtimes.map((runtime) => [runtime.runtime_id, runtime])),
    [runtimes],
  );
  const providerOptions = React.useMemo(() => readProviderOptions(publishedRows), [publishedRows]);
  const instructionBlocks = React.useMemo(() => readInstructionBlocks(publishedRows), [publishedRows]);
  const tools = React.useMemo(() => readToolDescriptors(publishedRows), [publishedRows]);
  const dispatchConfig = React.useMemo(() => readMessageDispatchConfig(publishedRows), [publishedRows]);
  const memories = React.useMemo(() => readMemoryRecords(publishedRows), [publishedRows]);
  const iconConfig = React.useMemo(() => readCapabilityIconConfig(publishedRows), [publishedRows]);
  const permissions = React.useMemo(() => readPermissionRows(publishedRows), [publishedRows]);

  const loading = publishedEntry === undefined;

  const [view, setView] = React.useState<HubView>('agents');
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<FilterValue>('active');
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(new Set());
  const [managedAgentId, setManagedAgentId] = React.useState<string | null>(null);
  const [managedEntityId, setManagedEntityId] = React.useState<string | null>(null);
  const requestedAgentId = readRequestedAgentId(surfaceInput);
  const [editAgentId, setEditAgentId] = React.useState<string | null | 'new'>(requestedAgentId);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!requestedAgentId) return;
    setView('agents');
    setManagedAgentId(null);
    setManagedEntityId(null);
    setEditAgentId(requestedAgentId);
  }, [requestedAgentId]);

  const cardById = React.useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const managedAgent = managedAgentId ? cardById.get(managedAgentId) : undefined;
  const editAgent: AgentProfileRecord | null =
    editAgentId && editAgentId !== 'new' ? (cardById.get(editAgentId)?.profile ?? null) : null;

  const visible = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return cards
      .filter((card) => (filter === 'archived' ? card.archived : !card.archived))
      .filter((card) =>
        term.length === 0 ||
        card.name.toLowerCase().includes(term) ||
        card.description.toLowerCase().includes(term) ||
        card.modelLabel.toLowerCase().includes(term),
      );
  }, [cards, filter, search]);

  const toggleSelect = React.useCallback((id: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const saveProfiles = React.useCallback(async (profiles: AgentProfileRecord[]) => {
    setBusy(true);
    try {
      await writeAgentProfiles(profiles);
    } finally {
      setBusy(false);
    }
  }, []);

  const sendMessage = React.useCallback(async (agentId: string, text: string) => {
    if (!dispatchConfig) throw new Error('message dispatch is not configured');
    await dispatchAgentMessage(dispatchConfig, {
      messageId: `agent_inbox:${crypto.randomUUID()}`,
      agentId,
      text,
      timestamp: new Date().toISOString(),
    });
  }, [dispatchConfig]);

  // Per-view building blocks — one primitive (HubEntity), every kind a
  // configuration of it (L069). `card` feeds the grid; `detail` feeds the
  // inline detail panel; `sourceAddress` (when present) makes it deletable.
  // All copy is human language; ids and refs never render.
  const agentNameById = React.useMemo(() => new Map(cards.map((card) => [card.id, card.name])), [cards]);
  const hiddenEntityIds = React.useMemo(() => readHiddenEntityIds(publishedRows), [publishedRows]);
  const allHubEntities = React.useMemo((): HubEntity[] => {
    const agentLabel = (ref: string | undefined) => (ref ? agentNameById.get(ref) : undefined);
    const usedByMeta = (count: number, verb: string) => (
      count > 0 ? { meta: count === 1 ? `1 agent ${verb}s this` : `${count} agents ${verb} this` } : {}
    );
    const usersOf = (predicate: (card: AgentCardViewModel) => boolean) =>
      cards.filter(predicate).map((card) => card.name);
    const withAddress = (entity: HubEntity, address: string | undefined): HubEntity =>
      (address ? { ...entity, sourceAddress: address } : entity);

    switch (view) {
      case 'models':
        return models.map((model) => {
          const users = usersOf((card) => card.profile.model_refs.includes(model.id));
          const placement = resolvePlacement(model, runtimeById, iconConfig);
          const name = model.display_name ?? model.id;
          const context = placement.label;
          const description = model.capabilities.length > 0 ? `Handles ${model.capabilities.join(', ')}.` : undefined;
          const icon = placement.icon;
          return withAddress({
            id: model.id,
            card: { icon, name, context, ...(description ? { description } : {}), ...usedByMeta(users.length, 'use') },
            detail: {
              icon, kindLabel: 'Model', name, context, ...(description ? { description } : {}), usedBy: users,
              fields: [
                ...(model.model_id ? [{ label: 'Model id', value: model.model_id }] : []),
                ...(model.capabilities.length > 0 ? [{ label: 'Capabilities', value: model.capabilities.join(', ') }] : []),
                { label: 'Location', value: context },
              ],
            },
          }, model.source_address);
        });
      case 'tools':
        return tools.map((tool) => {
          const users = usersOf((card) => card.profile.tool_refs.includes(tool.id));
          const name = tool.label ?? 'Tool';
          return withAddress({
            id: tool.id,
            card: {
              icon: 'Wrench', name, ...(tool.description ? { description: tool.description } : {}),
              ...(tool.status ? { badge: tool.status, badgeTone: 'muted' as const } : {}), ...usedByMeta(users.length, 'use'),
            },
            detail: {
              icon: 'Wrench', kindLabel: 'Tool', name, ...(tool.description ? { description: tool.description } : {}),
              ...(tool.status ? { badge: tool.status, badgeTone: 'muted' as const } : {}), usedBy: users,
              fields: tool.status ? [{ label: 'Status', value: tool.status }] : [],
            },
          }, tool.source_address);
        });
      case 'instructions':
        return instructionBlocks.map((block) => {
          const users = usersOf((card) => card.profile.instruction_refs.includes(block.id));
          const name = block.label ?? 'Instruction';
          return withAddress({
            id: block.id,
            card: { icon: 'ListOrdered', name, ...(block.body ? { description: block.body } : {}), ...usedByMeta(users.length, 'follow') },
            detail: { icon: 'ListOrdered', kindLabel: 'Instruction', name, ...(block.body ? { description: block.body } : {}), usedBy: users, fields: [] },
          }, block.source_address);
        });
      case 'memory': {
        const runtime: HubEntity[] = memoryFacts.map((fact) => {
          const name = fact.content.length > 64 ? `${fact.content.slice(0, 64)}…` : fact.content;
          const owner = fact.account ? agentNameById.get(fact.account) : undefined;
          const updated = formatRelativeTime(fact.updatedAt);
          return {
            id: `runtime-memory:${fact.id}`,
            card: { icon: 'Brain', name, ...(fact.account ? { context: fact.account } : {}), description: fact.content },
            detail: {
              icon: 'Brain', kindLabel: 'Memory', name, ...(fact.account ? { context: fact.account } : {}),
              description: fact.content, usedBy: owner ? [owner] : [],
              fields: [
                ...(fact.account ? [{ label: 'Account', value: fact.account }] : []),
                ...(updated ? [{ label: 'Updated', value: updated }] : []),
              ],
            },
            // live agent memory has no published home — shown, not deleted here
          };
        });
        const configured: HubEntity[] = memories.map((memory) => {
          const users = usersOf((card) => card.profile.memory_refs.includes(memory.id) || card.id === memory.agent_ref);
          const name = memory.label ?? memory.body.slice(0, 64);
          return withAddress({
            id: memory.id,
            card: { icon: 'Brain', name, ...(agentLabel(memory.agent_ref) ? { context: agentLabel(memory.agent_ref) } : {}), description: memory.body },
            detail: {
              icon: 'Brain', kindLabel: 'Memory', name, ...(agentLabel(memory.agent_ref) ? { context: agentLabel(memory.agent_ref) } : {}),
              description: memory.body, usedBy: users,
              fields: memory.memory_type ? [{ label: 'Type', value: memory.memory_type }] : [],
            },
          }, memory.source_address);
        });
        return [...runtime, ...configured];
      }
      case 'runs': {
        const byRecent = [...sessions].sort((left, right) =>
          (right.lastActivityAt ?? right.startedAt ?? '').localeCompare(left.lastActivityAt ?? left.startedAt ?? ''),
        );
        return byRecent.map((session) => {
          const agentName = agentLabel(session.agentId);
          const contextParts = [agentName, session.projectName].filter((part): part is string => Boolean(part));
          const when = formatRelativeTime(session.lastActivityAt ?? session.startedAt);
          const count = session.messageCount && session.messageCount > 0
            ? `${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}` : '';
          const name = session.title ?? session.prompt ?? 'Session';
          return {
            id: session.recordId,
            card: {
              icon: 'MessageSquare', name, ...(contextParts.length > 0 ? { context: contextParts.join(' · ') } : {}),
              ...(session.title && session.prompt ? { description: session.prompt } : {}),
              ...(session.model ? { badge: session.model, badgeTone: 'muted' as const } : {}),
            },
            detail: {
              icon: 'MessageSquare', kindLabel: 'Run', name, ...(contextParts.length > 0 ? { context: contextParts.join(' · ') } : {}),
              ...(session.prompt ? { description: session.prompt } : {}),
              ...(session.model ? { badge: session.model, badgeTone: 'muted' as const } : {}), usedBy: agentName ? [agentName] : [],
              fields: [
                ...(session.model ? [{ label: 'Model', value: session.model }] : []),
                ...(session.projectName ? [{ label: 'Project', value: session.projectName }] : []),
                ...(count ? [{ label: 'Messages', value: count }] : []),
                ...(when ? [{ label: 'Last active', value: when }] : []),
              ],
            },
            // runs are real execution history — no published home, not deleted here
          };
        });
      }
      case 'permissions':
        return permissions.map((permission) => {
          const owner = permission.subject_ref ? agentNameById.get(permission.subject_ref) : undefined;
          const icon = permission.allowed ? 'ShieldCheck' : 'ShieldX';
          const badge = permission.allowed ? 'Allowed' : 'Blocked';
          const badgeTone = (permission.allowed ? 'success' : 'error') as const;
          return withAddress({
            id: permission.id,
            card: { icon, name: permission.label, ...(permission.reason ? { description: permission.reason } : {}), badge, badgeTone },
            detail: {
              icon, kindLabel: 'Permission', name: permission.label, ...(permission.reason ? { description: permission.reason } : {}),
              badge, badgeTone, usedBy: owner ? [owner] : [],
              fields: [{ label: 'Status', value: badge }],
            },
          }, permission.source_address);
        });
      default:
        return [];
    }
  }, [view, models, runtimeById, tools, instructionBlocks, memories, memoryFacts, sessions, permissions, cards, agentNameById, iconConfig]);

  // Drop anything the user removed via the hide list (runs / live memory).
  const hubEntities = React.useMemo(
    () => allHubEntities.filter((entity) => !hiddenEntityIds.has(entity.id)),
    [allHubEntities, hiddenEntityIds],
  );

  const visibleEntities = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return hubEntities;
    return hubEntities.filter((entity) => (
      entity.card.name.toLowerCase().includes(term)
      || (entity.card.context ?? '').toLowerCase().includes(term)
      || (entity.card.description ?? '').toLowerCase().includes(term)
    ));
  }, [hubEntities, search]);

  const cappedEntities = visibleEntities.slice(0, ENTITY_RENDER_CAP);
  const hiddenEntityCount = visibleEntities.length - cappedEntities.length;

  const entityById = React.useMemo(() => new Map(hubEntities.map((entity) => [entity.id, entity])), [hubEntities]);
  const managedEntity = managedEntityId ? entityById.get(managedEntityId) : undefined;

  const viewLabel = HUB_VIEWS.find((entry) => entry.id === view)?.label ?? 'Agents';

  /** Permanent delete of any published building block — look up its raw payload
   *  by address and write it back tombstoned (status:'deleted'). Blocks without
   *  a writable home (live memory, run history) never reach here (no Delete). */
  const deleteEntity = React.useCallback(async (entity: HubEntity) => {
    if (entity.sourceAddress) {
      // Config record (model/tool/instruction/memory/permission) — real delete.
      if (!window.confirm(`Delete ${entity.detail.name}? This can't be undone.`)) return;
      const raw = publishedRows.find((row) => row.address === entity.sourceAddress);
      const payload = raw && raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
        ? (raw.payload as Record<string, unknown>)
        : { id: entity.id };
      setBusy(true);
      try {
        await softDeletePublishedRecords([{ sourceAddress: entity.sourceAddress, payload }]);
        setManagedEntityId(null);
      } finally {
        setBusy(false);
      }
      return;
    }
    // No writable source (a run transcript, a live memory fact) — hide it from
    // the hub without destroying the underlying truth (honest delete).
    if (!window.confirm(`Remove ${entity.detail.name} from the hub? The original stays on disk.`)) return;
    setBusy(true);
    try {
      await writeHiddenEntity(entity.id);
      setManagedEntityId(null);
    } finally {
      setBusy(false);
    }
  }, [publishedRows]);

  const selectedProfiles = React.useMemo(
    () => Array.from(selection).map((id) => cardById.get(id)?.profile).filter((profile): profile is AgentProfileRecord => Boolean(profile)),
    [selection, cardById],
  );

  const batchArchive = React.useCallback(async () => {
    await saveProfiles(selectedProfiles.map(archivedCopy));
    setSelection(new Set());
  }, [saveProfiles, selectedProfiles]);

  const batchMessage = React.useCallback(async () => {
    const text = window.prompt('Message to send to each selected agent:');
    if (!text || !text.trim()) return;
    for (const profile of selectedProfiles) {
      await sendMessage(profile.id, text.trim());
    }
    setSelection(new Set());
  }, [selectedProfiles, sendMessage]);

  if (loading) {
    return (
      <Container layout="vertical" alignItems="center" justifyContent="center" padding="lg" height="full">
        <Spinner />
      </Container>
    );
  }

  // ---- the persistent left column: the main switcher ----
  const leftColumn = (
    <Container layout="vertical" gap="xs" minWidth="184px" padding="md" overflow="y-auto">
      <Text variant="overline" color="faint">Manage</Text>
      {HUB_VIEWS.map((entry) => {
        const active = entry.id === view;
        return (
          <Card
            key={entry.id}
            variant={active ? 'nested' : 'ghost'}
            padding="sm"
            interactive
            onClick={() => { setView(entry.id); setManagedAgentId(null); setManagedEntityId(null); }}
            aria-label={entry.label}
          >
            <Container layout="horizontal" gap="sm" alignItems="center">
              <NamedIcon name={entry.icon} size="sm" />
              <Text variant="body-sm" {...(active ? { weight: 'semibold' as const } : {})}>{entry.label}</Text>
            </Container>
          </Card>
        );
      })}
    </Container>
  );

  // ---- main area ----
  const mainArea = managedAgent ? (
    <Container layout="vertical" flex="1" padding="lg" minHeight="0" overflow="hidden">
      <AgentManagerView
        agent={managedAgent}
        onBack={() => setManagedAgentId(null)}
        onEdit={(id) => setEditAgentId(id)}
        tools={tools}
        models={models}
        runtimes={runtimes}
        capabilityConfig={iconConfig}
        sessions={sessions}
        memories={memories}
        instructionBlocks={instructionBlocks}
        permissions={permissions}
      />
    </Container>
  ) : managedEntity ? (
    <Container layout="vertical" flex="1" padding="lg" minHeight="0" overflow="hidden">
      <EntityDetailView
        entity={managedEntity.detail}
        backLabel={viewLabel}
        onBack={() => setManagedEntityId(null)}
        onDelete={() => void deleteEntity(managedEntity)}
        busy={busy}
      />
    </Container>
  ) : (
    <Container layout="vertical" gap="md" flex="1" padding="lg" minHeight="0" overflow="hidden">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Container layout="vertical" flex="1">
          <Text variant="heading-lg">{viewLabel}</Text>
          <Text variant="body-xs" color="faint">
            {view === 'agents'
              ? `${cards.filter((card) => !card.archived).length} active`
              : String(hubEntities.length)}
          </Text>
        </Container>
        {view === 'agents' && (
          <SegmentedControl
            items={[{ id: 'active', label: 'Active' }, { id: 'archived', label: 'Archived' }]}
            value={filter}
            onValueChange={(value) => setFilter(value as FilterValue)}
            ariaLabel="Filter agents"
          />
        )}
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={`Search ${viewLabel.toLowerCase()}…`}
          aria-label={`Search ${viewLabel.toLowerCase()}`}
        />
        {view === 'agents' && (
          <Button variant="primary" size="md" onClick={() => setEditAgentId('new')}>New agent</Button>
        )}
      </Container>

      {view === 'agents' && (
        <BulkSelectBar
          selectedCount={selection.size}
          onClearAll={() => setSelection(new Set())}
          actions={[
            { label: 'Message all', onClick: () => void batchMessage(), disabled: busy },
            { label: 'Archive', onClick: () => void batchArchive(), disabled: busy },
          ]}
        />
      )}

      <Container layout="vertical" gap="sm" flex="1" overflow="y-auto" minHeight="0">
        {view === 'agents' ? (
          visible.length === 0 ? (
            <Container layout="vertical" alignItems="center" justifyContent="center" flex="1" gap="sm">
              <EmptyPlaceholder
                icon={Bot}
                message={filter === 'archived' ? 'No archived agents.' : search.trim() ? 'No agents match this search.' : 'No agents yet.'}
              />
              {filter === 'active' && !search.trim() && (
                <Button variant="primary" size="md" onClick={() => setEditAgentId('new')}>New agent</Button>
              )}
            </Container>
          ) : (
            <Container layout="grid" gap="md" gridCols="auto-fill-xs">
              {visible.map((card) => (
                <AgentCard
                  key={card.id}
                  agent={card}
                  selected={selection.has(card.id)}
                  onToggleSelect={toggleSelect}
                  onOpen={setManagedAgentId}
                  onEdit={(id) => { setManagedAgentId(null); setEditAgentId(id); }}
                  onDuplicate={(id) => {
                    const profile = cardById.get(id)?.profile;
                    if (!profile) return;
                    void saveProfiles([{
                      ...profile,
                      id: `ai-agent-profile:${crypto.randomUUID()}`,
                      label: `${profile.label ?? profile.id} copy`,
                    }]);
                  }}
                  onArchive={(id) => {
                    const profile = cardById.get(id)?.profile;
                    if (profile) void saveProfiles([archivedCopy(profile)]);
                  }}
                  onRestore={(id) => {
                    const profile = cardById.get(id)?.profile;
                    if (profile) void saveProfiles([restoredCopy(profile)]);
                  }}
                  onDelete={(id) => {
                    const profile = cardById.get(id)?.profile;
                    if (!profile) return;
                    if (!window.confirm(`Delete ${profile.label ?? profile.id}? Archived agents can be restored; deleted ones cannot.`)) return;
                    void saveProfiles([{ ...profile, status: 'deleted' }]);
                  }}
                />
              ))}
            </Container>
          )
        ) : visibleEntities.length === 0 ? (
          <Container layout="vertical" alignItems="center" justifyContent="center" flex="1" gap="sm">
            <EmptyPlaceholder
              icon={Bot}
              message={search.trim() ? 'Nothing matches this search.' : 'Nothing here yet.'}
            />
          </Container>
        ) : (
          <Container layout="vertical" gap="sm">
            <Container layout="grid" gap="md" gridCols="auto-fill-xs">
              {cappedEntities.map((entity) => (
                <EntityCard
                  key={entity.id}
                  {...entity.card}
                  onOpen={() => setManagedEntityId(entity.id)}
                  actions={[
                    { value: 'open', label: 'Open', icon: 'Maximize2' },
                    { value: 'delete', label: 'Delete', icon: 'Trash2', tint: '#fda4af' },
                  ]}
                  onAction={(value) => {
                    if (value === 'open') setManagedEntityId(entity.id);
                    if (value === 'delete') void deleteEntity(entity);
                  }}
                />
              ))}
            </Container>
            {hiddenEntityCount > 0 && (
              <Text variant="body-xs" color="faint">
                {`Showing ${String(cappedEntities.length)} of ${String(visibleEntities.length)} — search to narrow.`}
              </Text>
            )}
          </Container>
        )}
      </Container>
    </Container>
  );

  return (
    <Container layout="horizontal" gap="none" height="full" overflow="hidden">
      {leftColumn}
      {mainArea}
      {(editAgentId === 'new' || editAgent) && (
        <AgentEditView
          agent={editAgentId === 'new' ? null : editAgent}
          displayLabel={editAgentId === requestedAgentId && typeof surfaceInput?.display_label === 'string'
            ? surfaceInput.display_label.trim() || undefined : undefined}
          models={models}
          runtimes={runtimes}
          providerOptions={providerOptions}
          capabilityConfig={iconConfig}
          instructionBlocks={instructionBlocks}
          tools={tools}
          onSave={async (updated) => { await saveProfiles([updated]); }}
          onClose={() => setEditAgentId(null)}
        />
      )}
    </Container>
  );
}

export { blankAgentProfile };
