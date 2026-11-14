//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Full edit surface for one agent (or a new agent when `agent` is null).
// Reference anatomy: ElevenLabs stacked section cards + unsaved-changes bar.
// Sections: Identity (name + description), Model (grouped picker from live
// model descriptors / provider rows), Instructions (drag-to-reorder blocks +
// add/remove from the shared block library), Tools (pill multi-select),
// Archive/Delete (quiet, at the bottom). Saving emits ONE full-record write
// through the caller's onSave; the instruction order is the array order.
//
// =============================================================================

import React from 'react';
import {
  Button,
  CapabilityIconRow,
  Container,
  DragReorderList,
  Dropdown,
  Input,
  NamedIcon,
  SelectablePillBar,
  Text,
  Textarea,
} from '@/packages/ui';
import {
  resolvePlacement,
  type AgentProfileRecord,
  type CapabilityIconConfig,
  type InstructionBlockRecord,
  type ModelDescriptorRecord,
  type ModelRuntimeRecord,
  type ProviderOptionRecord,
  type ToolDescriptorRecord,
} from '@/packages/agents-hub/read-data/resolve-agent-cards';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

export interface AgentEditViewProps {
  /** Existing record, or null for the create flow */
  agent: AgentProfileRecord | null;
  /** Contextual assistant name, without rewriting the profile's stored identity. */
  displayLabel?: string;
  models: readonly ModelDescriptorRecord[];
  runtimes: readonly ModelRuntimeRecord[];
  providerOptions: readonly ProviderOptionRecord[];
  capabilityConfig: CapabilityIconConfig;
  instructionBlocks: readonly InstructionBlockRecord[];
  tools: readonly ToolDescriptorRecord[];
  /** Persists the complete updated record */
  onSave: (updated: AgentProfileRecord) => Promise<void>;
  onClose: () => void;
}

function draftFrom(agent: AgentProfileRecord | null): AgentProfileRecord {
  if (agent) return { ...agent, model_refs: [...agent.model_refs], tool_refs: [...agent.tool_refs], instruction_refs: [...agent.instruction_refs], memory_refs: [...agent.memory_refs] };
  return {
    id: `ai-agent-profile:${crypto.randomUUID()}`,
    model_refs: [],
    tool_refs: [],
    instruction_refs: [],
    memory_refs: [],
  };
}

function sameRecord(left: AgentProfileRecord, right: AgentProfileRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function AgentEditView({
  agent,
  displayLabel,
  models,
  runtimes,
  providerOptions,
  capabilityConfig,
  instructionBlocks,
  tools,
  onSave,
  onClose,
}: AgentEditViewProps) {
  const original = React.useMemo(() => draftFrom(agent), [agent]);
  const [draft, setDraft] = React.useState<AgentProfileRecord>(original);
  const [saving, setSaving] = React.useState(false);
  const [saveFailed, setSaveFailed] = React.useState(false);
  const [showBlockPicker, setShowBlockPicker] = React.useState(false);

  const dirty = !sameRecord(draft, original);
  const blockById = React.useMemo(
    () => new Map(instructionBlocks.map((block) => [block.id, block])),
    [instructionBlocks],
  );

  // Model picker rows — Mistral reference anatomy: models grouped under
  // provider headers, each row carrying its capability icons and a local/
  // cloud mark. Groups come from provider option records; models from live
  // model descriptors. Provider rows alone are the fallback when no model
  // descriptors exist yet. Everything is data — no vendor names in code.
  const modelItems = React.useMemo(() => {
    const optionByProviderId = new Map(providerOptions.map((option) => [option.provider_id, option]));
    if (models.length > 0) {
      const groups = new Map<string, typeof models[number][]>();
      for (const model of models) {
        const key = model.provider_ref ?? '';
        const list = groups.get(key) ?? [];
        list.push(model);
        groups.set(key, list);
      }
      const rows: { value: string; label: string; disabled?: boolean; icon?: string }[] = [];
      for (const [providerRef, groupModels] of groups) {
        const option = optionByProviderId.get(providerRef);
        rows.push({
          value: `group:${providerRef}`,
          label: option?.name ?? providerRef.replace(/^ai_provider:/, ''),
          disabled: true,
        });
        for (const model of groupModels) {
          rows.push({
            value: model.id,
            label: model.display_name ?? model.model_id ?? model.id,
          });
        }
      }
      return rows;
    }
    return providerOptions.map((option) => ({
      value: option.provider_id,
      label: option.name ?? option.provider_id,
    }));
  }, [models, providerOptions]);

  const modelById = React.useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const runtimeById = React.useMemo(
    () => new Map(runtimes.map((runtime) => [runtime.runtime_id, runtime])),
    [runtimes],
  );
  const iconByCapability = React.useMemo(
    () => new Map(capabilityConfig.icons.map((icon) => [icon.capability, icon])),
    [capabilityConfig.icons],
  );

  const availableBlocks = React.useMemo(
    () => instructionBlocks.filter((block) => !draft.instruction_refs.includes(block.id)),
    [instructionBlocks, draft.instruction_refs],
  );

  const save = React.useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await onSave(draft);
      onClose();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, draft, onSave, onClose]);

  return (
    <FloatingPanel open onClose={onClose} title={displayLabel ? `Configure ${displayLabel}` : agent ? 'Edit agent' : 'New agent'} width={576}>
      <Container layout="vertical" gap="md">
        <Container layout="vertical" gap="xs">
          <Text variant="overline" color="faint">Name</Text>
          <Input
            value={displayLabel ?? draft.label ?? ''}
            readOnly={Boolean(displayLabel)}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            placeholder="Agent name"
            aria-label="Agent name"
          />
          <Textarea
            value={draft.description ?? ''}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            placeholder="What this agent does"
            aria-label="What this agent does"
            rows={2}
          />
        </Container>


        <Container layout="vertical" gap="xs">
          <Text variant="overline" color="faint">Model</Text>
          <Dropdown
            items={modelItems}
            value={draft.model_refs[0] ?? ''}
            onValueChange={(value) => {
              if (value.startsWith('group:')) return;
              setDraft({ ...draft, model_refs: value ? [value] : [] });
            }}
            placeholder="Choose a model"
            aria-label="Model"
            size="md"
            scrollable
            renderItem={(item) => {
              if (item.value.startsWith('group:')) {
                return <Text variant="overline" color="faint">{item.label}</Text>;
              }
              const model = modelById.get(item.value);
              const placement = resolvePlacement(model, runtimeById, capabilityConfig);
              const capabilityItems = (model?.capabilities ?? [])
                .map((capability) => iconByCapability.get(capability))
                .filter((icon): icon is NonNullable<typeof icon> => Boolean(icon));
              return (
                <Container layout="horizontal" gap="sm" alignItems="center" width="full">
                  <NamedIcon name={placement.icon} size="xs" />
                  <Container layout="vertical" flex="1" overflow="hidden">
                    <Text variant="body-xs" truncate>{item.label}</Text>
                  </Container>
                  <CapabilityIconRow items={capabilityItems} />
                </Container>
              );
            }}
          />
        </Container>


        <Container layout="vertical" gap="xs">
          <Text variant="overline" color="faint">Instructions</Text>
          {draft.instruction_refs.length === 0 && (
            <Text variant="body-xs" color="faint">No instructions yet.</Text>
          )}
          {draft.instruction_refs.length > 0 && (
            <DragReorderList
              items={draft.instruction_refs.map((ref) => {
                const block = blockById.get(ref);
                return {
                  id: ref,
                  content: (
                    <Container layout="horizontal" gap="sm" alignItems="center">
                      <Container layout="vertical" flex="1" overflow="hidden">
                        <Text variant="body-xs" color={block ? 'strong' : 'faint'} truncate>
                          {block ? (block.label || 'Untitled block') : 'Unavailable block'}
                        </Text>
                        {block?.body && (
                          <Text variant="caption" color="faint" truncate>{block.body}</Text>
                        )}
                      </Container>
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-label="Remove block"
                        onClick={() => setDraft({
                          ...draft,
                          instruction_refs: draft.instruction_refs.filter((id) => id !== ref),
                        })}
                      >
                        Remove
                      </Button>
                    </Container>
                  ),
                };
              })}
              onReorder={(newIds) => {
                console.log(`[agents-hub] instructions reordered: ${newIds.join(',')}`);
                setDraft({ ...draft, instruction_refs: newIds });
              }}
            />
          )}
          {availableBlocks.length > 0 && (
            <Container layout="horizontal">
              <Button variant="outline" size="sm" onClick={() => setShowBlockPicker(true)}>
                Add a block
              </Button>
            </Container>
          )}
        </Container>


        <Container layout="vertical" gap="xs">
          <Text variant="overline" color="faint">Tools</Text>
          {tools.length === 0 && <Text variant="body-xs" color="faint">No tools available.</Text>}
          {tools.length > 0 && (
            <SelectablePillBar
              items={tools.map((tool) => ({ id: tool.id, label: tool.label ?? tool.id }))}
              selectedIds={draft.tool_refs}
              ariaLabel="Tools"
              onSelectAll={() => setDraft({
                ...draft,
                tool_refs: draft.tool_refs.length === tools.length ? [] : tools.map((tool) => tool.id),
              })}
              onToggle={(id) => setDraft({
                ...draft,
                tool_refs: draft.tool_refs.includes(id)
                  ? draft.tool_refs.filter((ref) => ref !== id)
                  : [...draft.tool_refs, id],
              })}
            />
          )}
        </Container>

        {saveFailed && (
          <Text variant="caption" color="error">Save didn’t go through. Try again.</Text>
        )}

        {dirty && (
          <Container layout="horizontal" gap="sm" justifyContent="end">
            <Button variant="ghost" size="md" onClick={() => setDraft(original)}>Clear</Button>
            <Button variant="primary" size="md" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </Container>
        )}
      </Container>

      {showBlockPicker && (
        <FloatingPanel open onClose={() => setShowBlockPicker(false)} title="Add a block" width={384}>
          <Container layout="vertical" gap="xs">
            {availableBlocks.map((block) => (
              <Button
                key={block.id}
                variant="ghost"
                size="md"
                onClick={() => {
                  console.log(`[agents-hub] block added: ${block.id}`);
                  setDraft({ ...draft, instruction_refs: [...draft.instruction_refs, block.id] });
                  setShowBlockPicker(false);
                }}
              >
                {block.label || 'Untitled block'}
              </Button>
            ))}
            {availableBlocks.length === 0 && (
              <Text variant="body-xs" color="faint">Every block is already added.</Text>
            )}
          </Container>
        </FloatingPanel>
      )}
    </FloatingPanel>
  );
}
