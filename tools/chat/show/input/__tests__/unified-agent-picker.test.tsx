// PORTED FROM: bitfield-packages/packages/chat/show/input/__tests__/unified-agent-picker.test.tsx @ e99ac5976
// UnifiedAgentPicker — model-row description rendering test.
//
// Proves the grounded picker anatomy (name + one-line capability blurb, the
// ChatGPT/Vibecode/Granola model-menu shape) is DATA-driven:
//   (1) a model whose data carries a blurb renders that blurb under its name,
//   (2) a model with no blurb renders name-only (no filler line),
//   (3) rows are grouped under the agent name section header.
// All three come from `participants` data — zero hardcoded model/agent names.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { UnifiedAgentPicker, cleanModelLabel, buildAgentCatalog } from '../unified-agent-picker';
import type { AddressedParticipantInfo } from '../../../read-data/read-addressed-exchange-participants';
import type { ChatSessionConfig } from '../../../read-data/read-chat-sessions';

afterEach(cleanup);

function participant(
  ref: string,
  label: string,
  models: AddressedParticipantInfo['models'],
  metadata: Record<string, unknown> = {},
): AddressedParticipantInfo {
  return {
    participantRef: ref,
    label,
    models,
    adapter: { kind: 'process-session' },
    accounts: [],
    connectionStates: [],
    serviceConnectionRefs: [],
    requiresAuth: false,
    routeRefs: [],
    setupRouteRefs: [],
    connectionStateRefs: [],
    ingestionRouteRefs: [],
    resultProjectionRefs: [],
    streamParseSpecRefs: [],
    proofRefs: [],
    blockerRefs: [],
    capability_refs: [],
    role_refs: [],
    source_refs: [],
    metadata,
  } as unknown as AddressedParticipantInfo;
}

const AUTO_CONFIG = {
  participantRefs: [],
  participantRef: null,
  model: null,
} as unknown as ChatSessionConfig;

function openMenu() {
  // The collapsed trigger is the only button before the popover opens.
  fireEvent.click(screen.getByRole('button'));
}

describe('UnifiedAgentPicker model-row descriptions', () => {
  it('renders the one-line blurb under a model that carries a description', () => {
    const participants = [
      participant('p:claude', 'Claude', [
        { id: 'opus', label: 'claude-opus', description: 'super expensive and smart' },
        { id: 'haiku', label: 'claude-haiku', description: 'super fast and cheap' },
      ]),
    ];
    render(
      <UnifiedAgentPicker
        participants={participants}
        config={AUTO_CONFIG}
        onSelect={() => {}}
        onSelectAuto={() => {}}
        canChange
      />,
    );
    openMenu();
    expect(screen.getByText('claude-opus')).toBeTruthy();
    expect(screen.getByText('super expensive and smart')).toBeTruthy();
    expect(screen.getByText('super fast and cheap')).toBeTruthy();
    // The agent name is the section header for its model rows.
    expect(screen.getByText('Claude')).toBeTruthy();
  });

  it('renders a model with no description as name-only (no filler line)', () => {
    const participants = [
      participant('p:codex', 'Codex', [{ id: 'gpt', label: 'gpt-5.5' }]),
    ];
    render(
      <UnifiedAgentPicker
        participants={participants}
        config={AUTO_CONFIG}
        onSelect={() => {}}
        onSelectAuto={() => {}}
        canChange
      />,
    );
    openMenu();
    expect(screen.getByText('gpt-5.5')).toBeTruthy();
    // Nothing in this menu carries the blurb copy.
    expect(screen.queryByText('super fast and cheap')).toBeNull();
  });
});

describe('UnifiedAgentPicker brand grouping — presentation identity over routing identity', () => {
  it('offers one assistant regardless of how many configured model routes it has', () => {
    const profile = participant('profile:helper', 'My assistant', [
      { id: 'model:old', label: 'Canceled provider' },
      { id: 'model:other', label: 'Other provider' },
    ], { participantKind: 'agent-profile', brandLabel: 'Your agents' });
    const catalog = buildAgentCatalog([profile]);
    expect(catalog).toHaveLength(2);
    expect(catalog[1]).toMatchObject({ rowLabel: 'My assistant', modelId: null });
  });
  // The product owner's complaint: three sections ("Codex", "GPT-5 (cloud)",
  // "OpenAI") for ONE vendor, because sections mirrored transport rows. These
  // tests pin the fix: sections come from brandLabel DATA, duplicate model ids
  // within a brand collapse to one row, the best transportPriority wins the
  // routing, and a model-less transport renders no fabricated "Default" row.
  it('merges two transports with the same brandLabel into ONE section', () => {
    const participants = [
      participant('cli:codex', 'Codex', [{ id: 'gpt-x', label: 'gpt-x' }], { brandLabel: 'OpenAI', transportPriority: 20 }),
      participant('cli:openai', 'OpenAI', [{ id: 'gpt-y', label: 'gpt-y' }], { brandLabel: 'OpenAI', transportPriority: 30 }),
    ];
    render(
      <UnifiedAgentPicker
        participants={participants}
        config={AUTO_CONFIG}
        onSelect={() => {}}
        onSelectAuto={() => {}}
        canChange
      />,
    );
    openMenu();
    // Both models render, under exactly one "OpenAI" header — no "Codex" header.
    expect(screen.getByText('gpt-x')).toBeTruthy();
    expect(screen.getByText('gpt-y')).toBeTruthy();
    expect(screen.getAllByText('OpenAI')).toHaveLength(1);
    expect(screen.queryByText('Codex')).toBeNull();
  });

  it('dedupes the same model id across transports; lower transportPriority wins routing', () => {
    const onSelect = vi.fn();
    const participants = [
      participant('cli:api', 'API Key', [{ id: 'shared-model', label: 'Shared Model' }], { brandLabel: 'OpenAI', transportPriority: 30 }),
      participant('cli:local', 'Local Proxy', [{ id: 'shared-model', label: 'Shared Model' }], { brandLabel: 'OpenAI', transportPriority: 10 }),
    ];
    render(
      <UnifiedAgentPicker
        participants={participants}
        config={AUTO_CONFIG}
        onSelect={onSelect}
        onSelectAuto={() => {}}
        canChange
      />,
    );
    openMenu();
    // ONE row for the shared model id…
    const rows = screen.getAllByText('Shared Model');
    expect(rows).toHaveLength(1);
    // …and picking it routes to the better-priority transport.
    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith('cli:local', 'shared-model');
  });

  it('renders NO fabricated "Default" row for a transport with zero models', () => {
    const participants = [
      participant('cli:gemini', 'Gemini', [], { brandLabel: 'Google', transportPriority: 20 }),
      participant('cli:google', 'Google AI', [{ id: 'g-flash', label: 'G Flash' }], { brandLabel: 'Google', transportPriority: 30 }),
    ];
    render(
      <UnifiedAgentPicker
        participants={participants}
        config={AUTO_CONFIG}
        onSelect={() => {}}
        onSelectAuto={() => {}}
        canChange
      />,
    );
    openMenu();
    expect(screen.queryByText('Default')).toBeNull();
    expect(screen.getByText('G Flash')).toBeTruthy();
    expect(screen.getAllByText('Google')).toHaveLength(1);
  });

  it('keeps same-brand rows CONTIGUOUS when transports interleave (one header per brand)', () => {
    // Registry order interleaves brands: OpenAI, Google, OpenAI — the catalog
    // must still emit all OpenAI rows adjacent, or the section header repeats
    // (the "three OpenAI headers" screenshot regression).
    const participants = [
      participant('cli:codex', 'Codex', [{ id: 'gpt-a', label: 'gpt-a' }], { brandLabel: 'OpenAI', transportPriority: 20 }),
      participant('cli:google', 'Google AI', [{ id: 'g-1', label: 'g-1' }], { brandLabel: 'Google', transportPriority: 30 }),
      participant('cli:openai', 'OpenAI', [{ id: 'gpt-b', label: 'gpt-b' }], { brandLabel: 'OpenAI', transportPriority: 30 }),
    ];
    const catalog = buildAgentCatalog(participants);
    const brands = catalog
      .filter((row): row is Extract<typeof catalog[number], { kind: 'model' }> => row.kind === 'model')
      .map((row) => (row.participant.metadata as Record<string, unknown>).brandLabel);
    // Contiguity: the brand sequence never returns to a brand it already left.
    const runs: unknown[] = [];
    for (const brand of brands) if (runs[runs.length - 1] !== brand) runs.push(brand);
    expect(runs).toEqual(['OpenAI', 'Google']);
    expect(brands).toEqual(['OpenAI', 'OpenAI', 'Google']);
  });

  it('falls back to the transport label as brand when no brandLabel/provider DATA exists', () => {
    const participants = [
      participant('cli:mystery', 'Mystery', [{ id: 'm1', label: 'M One' }]),
    ];
    render(
      <UnifiedAgentPicker
        participants={participants}
        config={AUTO_CONFIG}
        onSelect={() => {}}
        onSelectAuto={() => {}}
        canChange
      />,
    );
    openMenu();
    expect(screen.getByText('Mystery')).toBeTruthy();
    expect(screen.getByText('M One')).toBeTruthy();
  });

  it('does not collapse two agent profiles that share one model', () => {
    const onSelect = vi.fn();
    const participants = [
      participant(
        'ai-agent-profile:founder-operator',
        'Founder operator',
        [{ id: 'claude-sonnet', label: 'Claude Sonnet' }],
        { brandLabel: 'Your agents', participantKind: 'agent-profile' },
      ),
      participant(
        'ai-agent-profile:researcher',
        'Researcher',
        [{ id: 'claude-sonnet', label: 'Claude Sonnet' }],
        { brandLabel: 'Your agents', participantKind: 'agent-profile' },
      ),
    ];
    render(
      <UnifiedAgentPicker
        participants={participants}
        config={AUTO_CONFIG}
        onSelect={onSelect}
        onSelectAuto={() => {}}
        canChange
      />,
    );
    openMenu();
    expect(screen.getByText('Founder operator')).toBeTruthy();
    expect(screen.getByText('Researcher')).toBeTruthy();
    expect(screen.queryByText(/Claude Sonnet/)).toBeNull();
    expect(screen.getAllByText('Your agents')).toHaveLength(1);
    fireEvent.click(screen.getByText('Researcher'));
    expect(onSelect).toHaveBeenCalledWith('ai-agent-profile:researcher', null);
  });
});

describe('cleanModelLabel — product-chip hygiene (L114, generic, no model vocabulary)', () => {
  it('strips a trailing 8-digit release date from a raw-id-derived label', () => {
    expect(cleanModelLabel('Claude 3 7 Sonnet 20250219')).toBe('Claude 3 7 Sonnet');
  });

  it('strips a trailing long commit/hash suffix', () => {
    expect(cleanModelLabel('Llama 3 8b Instruct a1b2c3d4e5f60718')).toBe('Llama 3 8b Instruct');
  });

  it('leaves clean human labels untouched (no false positives)', () => {
    for (const label of ['GPT-5.4 High', 'Opus 4.8', 'Gemini 2.5 Flash', 'Sonnet 4.6', 'gpt-5.5', 'Default']) {
      expect(cleanModelLabel(label)).toBe(label);
    }
  });

  it('never collapses a label to empty and tolerates non-strings', () => {
    expect(cleanModelLabel('20250219')).toBe('20250219'); // sole token is not stripped
    expect(cleanModelLabel('  ')).toBe('');
    expect(cleanModelLabel(undefined as unknown as string)).toBe('');
  });
});

describe('UnifiedAgentPicker trigger chip uses the cleaned label', () => {
  it('shows "Claude · Claude 3 7 Sonnet" — not the raw 20250219 date — in the chip', () => {
    const participants = [
      participant('p:claude', 'Claude', [
        { id: 'claude-3-7-sonnet-20250219', label: 'Claude 3 7 Sonnet 20250219' },
      ]),
    ];
    const config = {
      participantRefs: ['p:claude'],
      participantRef: 'p:claude',
      model: 'claude-3-7-sonnet-20250219',
    } as unknown as ChatSessionConfig;
    render(
      <UnifiedAgentPicker
        participants={participants}
        config={config}
        onSelect={() => {}}
        onSelectAuto={() => {}}
        canChange
      />,
    );
    expect(screen.getByText('Claude · Claude 3 7 Sonnet')).toBeTruthy();
    expect(screen.queryByText(/20250219/)).toBeNull();
  });

  it('shows the agent profile name first when the selected row is a profile', () => {
    const participants = [
      participant(
        'ai-agent-profile:founder-operator',
        'Founder operator',
        [{ id: 'claude-sonnet', label: 'Claude Sonnet' }],
        { brandLabel: 'Your agents', participantKind: 'agent-profile' },
      ),
    ];
    const config = {
      participantRefs: ['ai-agent-profile:founder-operator'],
      participantRef: 'ai-agent-profile:founder-operator',
      model: 'claude-sonnet',
    } as unknown as ChatSessionConfig;
    render(
      <UnifiedAgentPicker
        participants={participants}
        config={config}
        onSelect={() => {}}
        onSelectAuto={() => {}}
        canChange
      />,
    );
    expect(screen.getByText('Founder operator')).toBeTruthy();
    expect(screen.queryByText(/Claude Sonnet/)).toBeNull();
  });

  it('places a compact configuration control beside a selected configurable profile', () => {
    const profile = participant(
      'ai-agent-profile:founder-operator',
      'Founder operator',
      [{ id: 'claude-sonnet', label: 'Claude Sonnet' }],
      { brandLabel: 'Your agents', participantKind: 'agent-profile' },
    );
    const onConfigureParticipant = vi.fn();
    render(
      <UnifiedAgentPicker
        participants={[profile]}
        config={{
          participantRefs: [profile.participantRef],
          participantRef: profile.participantRef,
          model: 'claude-sonnet',
        } as unknown as ChatSessionConfig}
        onSelect={() => {}}
        onSelectAuto={() => {}}
        onConfigureParticipant={onConfigureParticipant}
        canConfigureParticipant={() => true}
        canChange
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Configure Founder operator' }));
    expect(onConfigureParticipant).toHaveBeenCalledWith(profile);
  });
});
