import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentEditView } from '../AgentEditView';

import { readRequestedAgentId } from '@/packages/agents-hub/show/AgentsHubSurface';

describe('Agents Hub addressed surface input', () => {
  it('keeps a contextual assistant name without modifying the stored profile', () => {
    const agent = { id: 'profile:internal', label: 'Internal role', model_refs: [], tool_refs: [], instruction_refs: [], memory_refs: [] };
    render(React.createElement(AgentEditView, { agent, displayLabel: 'Assistant name', models: [], runtimes: [], providerOptions: [],
      capabilityConfig: { icons: [] } as never, instructionBlocks: [], tools: [], onSave: async () => {}, onClose: () => {} }));
    expect(screen.getByLabelText('Agent name')).toHaveProperty('value', 'Assistant name');
    expect(screen.getByLabelText('Agent name')).toHaveProperty('readOnly', true);
    expect(agent.label).toBe('Internal role');
    cleanup();
  });
  it('reads an opaque profile subject and rejects unrelated input', () => {
    expect(readRequestedAgentId({ subject_ref: 'ai-agent-profile:researcher' }))
      .toBe('ai-agent-profile:researcher');
    expect(readRequestedAgentId({ subject_ref: '' })).toBeNull();
    expect(readRequestedAgentId({ participant_ref: 'not-owner-input' })).toBeNull();
  });

  // This assertion used to require the OPPOSITE: that the surface take its partition from
  // the generated package-entry binding, on the reasoning that a generated value beats a
  // hardcoded product default. The generated value IS the package set's build-time label,
  // which is the retired app this set was built for, so the guard enforced the defect it
  // was written to prevent. Every hub write landed in another app's store.
  //
  // The correct invariant is that the surface says nothing about partitions. The engine
  // resolves an omitted partition to the one the request arrived on.
  it('names no partition at all, so hub writes land in the store of the app serving them', () => {
    const sourcePath = 'packages/agents-hub/show/AgentsHubSurface.tsx';
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toContain('PARTITION_LABEL');
    expect(source).not.toContain('partition_label');
    expect(source).not.toContain('bitfield-studio');
  });
});
