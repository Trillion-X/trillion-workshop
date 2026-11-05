// Dropdown that arranges the current selection by a layout strategy id.
import React from 'react';
import { Button, Dropdown } from '../../ui/index.ts';
import { ARRANGE_STRATEGIES } from './arrange-strategies.ts';

function titleCase(id: string): string {
  if (id.length === 0) return id;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function arrangeStrategyItems(
  strategies: Readonly<Record<string, unknown>> = ARRANGE_STRATEGIES,
): Array<{ value: string; label: string; icon?: string }> {
  return Object.keys(strategies).map((id) => ({
    value: id,
    label: titleCase(id),
    icon: 'LayoutGrid',
  }));
}

export interface ArrangeMenuProps {
  readonly disabled?: boolean;
  readonly onArrange: (strategyId: string) => void;
  readonly strategies?: Readonly<Record<string, unknown>>;
}

export function ArrangeMenu(props: ArrangeMenuProps): JSX.Element {
  return (
    <Dropdown
      items={arrangeStrategyItems(props.strategies)}
      value=""
      onValueChange={(id) => props.onArrange(id)}
      align="start"
      aria-label="Arrange selection"
      customTrigger={
        <Button variant="ghost" size="sm" aria-label="Arrange selection" disabled={props.disabled}>
          Arrange
        </Button>
      }
    />
  );
}
