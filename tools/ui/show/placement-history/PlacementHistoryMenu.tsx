import * as React from 'react';
import { Dropdown, type DropdownItem } from '../dropdown/Dropdown';
import { PLACEMENT_HISTORY_STYLE } from '../../../screen-look/show/placement-history-style';

/** Caller-owned option rendered in the placement history menu. */
export interface PlacementHistoryEntry {
  id: string;
  label: string;
  description?: string;
}

export interface PlacementHistoryMenuProps {
  /** Compact trigger supplied by the consuming surface. */
  trigger: React.ReactElement;
  presets?: readonly PlacementHistoryEntry[];
  recentChoices?: readonly PlacementHistoryEntry[];
  onSelectPreset: (entry: PlacementHistoryEntry) => void;
  onSelectChoice: (entry: PlacementHistoryEntry) => void;
  ariaLabel?: string;
  maxHeight?: string;
}

/**
 * Domain-blind saved and recent choice menu. It delegates popover behavior,
 * focus management, escape handling, and list keyboard controls to Dropdown.
 */
export function PlacementHistoryMenu({
  trigger,
  presets = [],
  recentChoices = [],
  onSelectPreset,
  onSelectChoice,
  ariaLabel = 'Saved and recent choices',
  maxHeight = 'min(50vh, 20rem)',
}: PlacementHistoryMenuProps) {
  const entries = React.useMemo(() => [
    ...presets.map((entry) => ({ entry, kind: 'preset' as const })),
    ...recentChoices.map((entry) => ({ entry, kind: 'choice' as const })),
  ], [presets, recentChoices]);
  const items: DropdownItem[] = entries.map(({ entry, kind }) => ({
    value: `${kind}:${entry.id}`,
    label: entry.label,
    description: entry.description,
    section: kind === 'preset' ? 'Saved' : 'Recent',
  }));

  return <>
    <style>{PLACEMENT_HISTORY_STYLE}</style>
    <Dropdown
      items={items}
      value=""
      onValueChange={(value) => {
        const item = entries.find(({ entry, kind }) => `${kind}:${entry.id}` === value);
        if (!item) return;
        if (item.kind === 'preset') onSelectPreset(item.entry);
        else onSelectChoice(item.entry);
      }}
      customTrigger={trigger}
      aria-label={ariaLabel}
      header=""
      scrollable={maxHeight}
      contentClassName="bf-placement-history-list"
    />
  </>;
}
