import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { useBitfieldData } from '@/packages/poker-rules/.bitfield-entry-scope/poker-rules/runtime-kit-react';
import { createPokerHandState, createPokerPlayers, type PokerTableConfig } from '@/packages/poker-rules/read-data/poker-rules';
import { PokerRuleSummary } from '@/packages/poker-rules/show/PokerRuleSummary';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function PokerRulesMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceState = object(useBitfieldData<unknown>('surface-state'));
  const config = object(surfaceState.config) as Partial<PokerTableConfig>;
  const startingChips = typeof config.startingChips === 'number' ? config.startingChips : 0;
  const playerNames = stringArray(surfaceState.player_names);
  const state = createPokerHandState(createPokerPlayers(playerNames, startingChips), {
    ...config,
    maxPlayers: playerNames.length,
  });
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="poker rules material">
        <PokerRuleSummary state={state} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <PokerRulesMaterial props={props} />);
}
